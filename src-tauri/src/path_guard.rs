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

/// Normalize a path for prefix comparison: forward slashes, no trailing slash,
/// and (on Windows) lower-cased since the filesystem is case-insensitive.
fn normalize(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
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
}
