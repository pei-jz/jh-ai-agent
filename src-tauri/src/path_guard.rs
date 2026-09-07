// Defense-in-depth path allowlist for mutating filesystem / shell commands.
//
// The JavaScript layer (ToolExecutor) already gates dangerous operations with
// user confirmation, but it is the *trusted controller* — a logic bug there, or
// a malicious task driving the agent, could still ask the Rust backend to write
// to or delete arbitrary paths. This guard is the backstop: regardless of what
// the frontend requests, the backend refuses to MUTATE paths that are not
// inside an explicitly-allowed root.
//
// Scope: enforced on write_file, create_dir, delete_dir, delete_file, move_file
// (destination), and run_command (working directory). READ operations are left
// unrestricted on purpose — browsing/indexing arbitrary files is a core feature
// and reads are far lower risk than writes/exec.
//
// Roots are seeded at startup with the app config dir and the OS temp dir, then
// extended by the frontend (workspace, approved projects, configured log dir,
// and any path the user explicitly approves for an out-of-workspace write).

use std::path::Path;
use std::sync::Mutex;

#[derive(Default)]
pub struct PathGuard {
    roots: Mutex<Vec<String>>,
}

impl PathGuard {
    /// Add a single allowed root (idempotent).
    pub fn add_root<P: AsRef<Path>>(&self, p: P) {
        let norm = normalize(p.as_ref());
        if norm.is_empty() {
            return;
        }
        let mut roots = self.roots.lock().unwrap();
        if !roots.iter().any(|r| r == &norm) {
            roots.push(norm);
        }
    }

    /// Merge a batch of allowed roots (idempotent).
    pub fn add_roots(&self, paths: &[String]) {
        for p in paths {
            self.add_root(p);
        }
    }

    /// True if `path` equals or is nested under any allowed root.
    pub fn is_allowed<P: AsRef<Path>>(&self, path: P) -> bool {
        let target = normalize(path.as_ref());
        if target.is_empty() {
            return false;
        }
        let roots = self.roots.lock().unwrap();
        roots.iter().any(|root| is_within(&target, root))
    }

    /// Returns Ok(()) if allowed, otherwise a descriptive Err for the caller to
    /// propagate back to the frontend.
    pub fn ensure_allowed<P: AsRef<Path>>(&self, path: P) -> Result<(), String> {
        if self.is_allowed(&path) {
            Ok(())
        } else {
            Err(format!(
                "Path guard: operation blocked — '{}' is outside all allowed roots. \
                 Register the directory (or approve the action) before retrying.",
                path.as_ref().display()
            ))
        }
    }

    /// Snapshot of the current roots (for diagnostics).
    pub fn list(&self) -> Vec<String> {
        self.roots.lock().unwrap().clone()
    }
}

/// Normalize a path for prefix comparison: `..` and `.` resolved, forward
/// slashes, no trailing slash, and (on Windows) lower-cased since the
/// filesystem is case-insensitive.
///
/// Resolving `..` is the whole job. Without it this was a plain string prefix
/// test, so with `C:/work/project` allowed, `C:/work/project/../secret.txt`
/// started with the root and was judged INSIDE — while the filesystem call it
/// guards resolved the same string to `C:/work/secret.txt`, outside. Every
/// mutating command (write_file / create_dir / delete_dir / delete_file /
/// move_file / run_command's cwd) leans on this, so "the backstop for when the
/// JS layer is wrong" did not hold.
///
/// Done LEXICALLY rather than with `canonicalize`, because a write is usually
/// to a path that does not exist yet and canonicalize fails on those. The known
/// limit of that choice: a symlink inside an allowed root pointing out of it is
/// still followed by the OS. Containing that needs the resolved parent, which
/// belongs to the callers that know whether the file must already exist.
fn normalize(p: &Path) -> String {
    use std::path::Component;

    let mut out: Vec<String> = Vec::new();
    let mut base = String::new();      // prefix (C:) and/or root (/), kept whole
    for comp in p.components() {
        match comp {
            Component::Prefix(pre) => {
                base = pre.as_os_str().to_string_lossy().replace('\\', "/");
            }
            Component::RootDir => base.push('/'),
            Component::CurDir => {}
            Component::ParentDir => {
                // Popping past the base leaves the path SHORTER than any root,
                // so `is_within` rejects it — which is the answer we want for
                // a path that climbed out of everything.
                out.pop();
            }
            Component::Normal(seg) => out.push(seg.to_string_lossy().to_string()),
        }
    }

    let joined = out.join("/");
    let s = if base.is_empty() {
        joined
    } else if base.ends_with('/') {
        format!("{}{}", base, joined)
    } else if joined.is_empty() {
        base
    } else {
        format!("{}/{}", base, joined)
    };

    let trimmed = s.trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        trimmed.to_lowercase()
    } else {
        trimmed
    }
}

/// Component-aware containment test so "/foo" does NOT match "/foobar".
/// Both inputs are already normalized strings.
fn is_within(target: &str, root: &str) -> bool {
    if target == root {
        return true;
    }
    // target must start with `root/` to be strictly nested.
    let mut prefix = String::with_capacity(root.len() + 1);
    prefix.push_str(root);
    prefix.push('/');
    target.starts_with(&prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_exact_and_nested() {
        let g = PathGuard::default();
        g.add_root("C:/work/project");
        assert!(g.is_allowed("C:/work/project"));
        assert!(g.is_allowed("C:/work/project/src/main.rs"));
    }

    #[test]
    fn rejects_outside_and_sibling_prefix() {
        let g = PathGuard::default();
        g.add_root("C:/work/project");
        assert!(!g.is_allowed("C:/work/project-evil/secret.txt")); // sibling prefix
        assert!(!g.is_allowed("C:/other/file.txt"));
        assert!(!g.is_allowed("")); // empty
    }

    #[test]
    fn empty_guard_denies_everything() {
        let g = PathGuard::default();
        assert!(!g.is_allowed("C:/anything"));
        assert!(g.ensure_allowed("C:/anything").is_err());
    }

    #[test]
    fn backslash_and_case_insensitive_on_windows() {
        let g = PathGuard::default();
        g.add_root("C:\\Work\\Project");
        if cfg!(target_os = "windows") {
            assert!(g.is_allowed("c:/work/project/file.txt"));
        }
    }

    #[test]
    fn add_roots_is_idempotent() {
        let g = PathGuard::default();
        g.add_roots(&["C:/a".into(), "C:/a".into(), "C:/b".into()]);
        assert_eq!(g.list().len(), 2);
    }

    // ── traversal ────────────────────────────────────────────────────────
    //
    // The guard exists for the case where the trusted JS layer is wrong, so a
    // path that CLIMBS OUT of an allowed root has to be refused here. It was
    // not: normalize left `..` in place and is_within was a string prefix
    // test, so `<root>/../secret.txt` started with `<root>/` and passed —
    // while the filesystem call it guards resolved it to a sibling of the root.

    #[test]
    fn a_path_that_climbs_out_of_a_root_is_refused() {
        let g = PathGuard::default();
        g.add_root("C:/work/project");

        assert!(!g.is_allowed("C:/work/project/../secret.txt"));
        assert!(!g.is_allowed("C:/work/project/sub/../../secret.txt"));
        assert!(!g.is_allowed("C:/work/project/../../etc/passwd"));
        // Backslashes are the same path on Windows and must not be a way round.
        assert!(!g.is_allowed(r"C:\work\project\..\secret.txt"));
    }

    #[test]
    fn climbing_back_in_is_still_inside() {
        let g = PathGuard::default();
        g.add_root("C:/work/project");
        // Resolves to C:/work/project/src/a.rs — inside, and refusing it would
        // break ordinary relative paths.
        assert!(g.is_allowed("C:/work/project/sub/../src/a.rs"));
        assert!(g.is_allowed("C:/work/project/./src/a.rs"));
    }

    #[test]
    fn climbing_past_the_drive_lands_nowhere_allowed() {
        let g = PathGuard::default();
        g.add_root("C:/work");
        assert!(!g.is_allowed("C:/work/../../../../secret.txt"));
    }

    // A root given with `..` in it means the directory it resolves to.
    #[test]
    fn a_root_is_resolved_too() {
        let g = PathGuard::default();
        g.add_root("C:/work/project/../project");
        assert!(g.is_allowed("C:/work/project/src/a.rs"));
        assert!(!g.is_allowed("C:/work/other/a.rs"));
    }

    // The sibling-prefix case this file already guarded, still guarded.
    #[test]
    fn a_sibling_with_a_shared_prefix_is_still_outside() {
        let g = PathGuard::default();
        g.add_root("C:/work/proj");
        assert!(!g.is_allowed("C:/work/project/a.rs"));
    }

}
