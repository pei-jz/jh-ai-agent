// Search & filesystem-mutation commands.
//
// Provides:
//   • grep_search  — content search across files (regex, respects .gitignore)
//   • glob_files   — file-pattern search (glob, respects .gitignore)
//   • delete_file  — delete a single file
//   • move_file    — rename or move a file/directory
//
// All paths are absolute. Caller (JS-side ToolExecutor) is responsible for
// resolving relative paths against the workspace root before invoking.

use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::path::Path;
use crate::path_guard::PathGuard;

/// Split a comma-separated glob list WITHOUT splitting inside brace groups
/// (`{a,b}`) — so `"*.{js,ts},src/**/*.rs"` yields `["*.{js,ts}", "src/**/*.rs"]`.
/// Commas inside braces are part of the alternation syntax, not list separators.
fn split_glob_list(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut depth: usize = 0;
    for c in s.chars() {
        match c {
            '{' => { depth += 1; cur.push(c); }
            '}' => { depth = depth.saturating_sub(1); cur.push(c); }
            ',' if depth == 0 => { parts.push(std::mem::take(&mut cur)); }
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    parts
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

// ── grep_search ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub files_searched: usize,
    pub truncated: bool,
}

/// Recursively search for a regex pattern across files under `path`, respecting
/// .gitignore. Returns up to `max_results` matches.
///
/// Arguments:
///   pattern          - regex pattern (Rust regex syntax). Use case_insensitive=true for /i.
///   path             - root directory to search (absolute). Default: current working dir.
///   include_glob     - optional glob to filter files (e.g. "*.{js,ts}"). Multiple globs
///                      can be comma-separated.
///   case_insensitive - default false.
///   max_results      - default 200. Hard cap 2000 to protect agent context.
///   context_lines    - number of lines of context to include above/below each match.
///                      Default 0. Hard cap 5.
#[tauri::command]
pub async fn grep_search(
    pattern: String,
    path: Option<String>,
    include_glob: Option<String>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    context_lines: Option<usize>,
) -> Result<GrepResult, String> {
    if pattern.trim().is_empty() {
        return Err("pattern must not be empty".to_string());
    }

    let root = path.unwrap_or_else(|| ".".to_string());
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Search root does not exist: {}", root));
    }

    let case_insensitive = case_insensitive.unwrap_or(false);
    let max_results = max_results.unwrap_or(200).min(2000);
    let context_lines = context_lines.unwrap_or(0).min(5);

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| format!("Invalid regex '{}': {}", pattern, e))?;

    // Optional file-pattern filter (comma-separated globs).
    let glob_set = if let Some(g) = include_glob.as_ref().filter(|s| !s.trim().is_empty()) {
        let mut builder = GlobSetBuilder::new();
        for piece in split_glob_list(g) {
            let glob = Glob::new(&piece)
                .map_err(|e| format!("Invalid include_glob '{}': {}", piece, e))?;
            builder.add(glob);
        }
        Some(
            builder
                .build()
                .map_err(|e| format!("Glob set build failed: {}", e))?,
        )
    } else {
        None
    };

    let mut matches: Vec<GrepMatch> = Vec::new();
    let mut files_searched: usize = 0;
    let mut truncated = false;

    // ignore::WalkBuilder honors .gitignore / .ignore / hidden by default.
    let walker = WalkBuilder::new(root_path)
        .hidden(true)        // skip dotfiles
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .build();

    'outer: for entry in walker.flatten() {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let p = entry.path();

        // include_glob filter — match against the file name AND the full path so
        // patterns like "*.js" or "src/**/*.ts" both work.
        if let Some(gs) = &glob_set {
            let name_ok = p
                .file_name()
                .map(|n| gs.is_match(Path::new(n)))
                .unwrap_or(false);
            let path_ok = gs.is_match(p);
            if !name_ok && !path_ok {
                continue;
            }
        }

        // Skip likely-binary files by a size+extension heuristic to keep grep cheap.
        if is_likely_binary_path(p) {
            continue;
        }

        // Read as bytes, then attempt UTF-8 — bail on non-UTF-8 (skip binaries).
        let bytes = match std::fs::read(p) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Cheap binary detector: NUL byte in first 8KB → binary.
        let sniff_end = bytes.len().min(8192);
        if bytes[..sniff_end].contains(&0u8) {
            continue;
        }
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue, // skip files that aren't valid UTF-8
        };

        files_searched += 1;
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            // Build the match payload (optionally with surrounding context).
            let display = if context_lines == 0 {
                (*line).to_string()
            } else {
                let lo = i.saturating_sub(context_lines);
                let hi = (i + context_lines + 1).min(lines.len());
                lines[lo..hi]
                    .iter()
                    .enumerate()
                    .map(|(off, l)| format!("{}: {}", lo + off + 1, l))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            matches.push(GrepMatch {
                file: p.to_string_lossy().into_owned(),
                line: i + 1,
                text: display,
            });
            if matches.len() >= max_results {
                truncated = true;
                break 'outer;
            }
        }
    }

    Ok(GrepResult {
        matches,
        files_searched,
        truncated,
    })
}

/// Cheap "this is probably binary" check based on common extensions and size.
fn is_likely_binary_path(p: &Path) -> bool {
    const BIN_EXT: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff",
        "zip", "tar", "gz", "7z", "rar", "xz",
        "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "mp3", "mp4", "mov", "avi", "wav", "flac", "ogg",
        "ttf", "otf", "woff", "woff2", "eot",
        "class", "jar", "war",
        "pyc", "pyo",
        "wasm",
        "db", "sqlite", "sqlite3",
    ];
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        let lower = ext.to_ascii_lowercase();
        if BIN_EXT.iter().any(|&e| e == lower) {
            return true;
        }
    }
    // Cap on file size — don't bother grepping multi-megabyte files.
    if let Ok(md) = std::fs::metadata(p) {
        if md.len() > 5 * 1024 * 1024 {
            return true;
        }
    }
    false
}

// ── glob_files ─────────────────────────────────────────────────────────────────

/// Cheap change-detection stamp for one file: what the OS already knows about
/// it. Returned only when the caller asks (`with_stamps`), so the common glob
/// stays a plain list of paths.
#[derive(Debug, Serialize)]
pub struct FileStamp {
    pub path: String,
    pub size: u64,
    /// Unix epoch milliseconds. 0 when the platform/file has no mtime.
    pub mtime_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct GlobResult {
    pub files: Vec<String>,
    pub truncated: bool,
    /// Present only for `with_stamps: true`. Same order as `files`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stamps: Option<Vec<FileStamp>>,
}

/// List files under `path` matching a glob pattern (e.g. "**/*.test.js").
/// Respects .gitignore by default.
///
/// Arguments:
///   pattern     - glob pattern. Use `**` for arbitrary directories, `*` for any chars within
///                 a single segment. Examples: "*.md", "src/**/*.ts", "**/*test*"
///   path        - root to search (absolute). Default: current working dir.
///   max_results - default 500. Hard cap 100000.
///
/// The hard cap is what the memory "study workspace" pass runs into: it globs
/// the whole tree first so its fair-share selection can spread over the REAL
/// shape of the project, and a ceiling below the tree size silently biases that
/// selection toward whatever the walker reached first. Only paths are collected
/// here (no file contents), so a larger ceiling costs a directory walk and a
/// vector of strings.
#[tauri::command]
pub async fn glob_files(
    pattern: String,
    path: Option<String>,
    max_results: Option<usize>,
    with_stamps: Option<bool>,
) -> Result<GlobResult, String> {
    if pattern.trim().is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    let root = path.unwrap_or_else(|| ".".to_string());
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Glob root does not exist: {}", root));
    }
    let max_results = max_results.unwrap_or(500).min(100000);

    let glob = Glob::new(&pattern)
        .map_err(|e| format!("Invalid glob '{}': {}", pattern, e))?;
    let matcher = glob.compile_matcher();

    let want_stamps = with_stamps.unwrap_or(false);
    let mut files: Vec<String> = Vec::new();
    let mut stamps: Vec<FileStamp> = Vec::new();
    let mut truncated = false;

    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .build();

    for entry in walker.flatten() {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let p = entry.path();
        // Match against the path RELATIVE to the search root, so patterns like
        // "src/**/*.ts" work intuitively when the root is the project dir.
        let rel = p.strip_prefix(root_path).unwrap_or(p);
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matcher.is_match(rel) || matcher.is_match(name) {
            let full = p.to_string_lossy().into_owned();
            if want_stamps {
                // The walker already stat()ed this entry, so size+mtime are
                // effectively free here — and they let a caller skip READING a
                // file that cannot have changed.
                let (size, mtime_ms) = entry
                    .metadata()
                    .ok()
                    .map(|m| {
                        let mt = m
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        (m.len(), mt)
                    })
                    .unwrap_or((0, 0));
                stamps.push(FileStamp { path: full.clone(), size, mtime_ms });
            }
            files.push(full);
            if files.len() >= max_results {
                truncated = true;
                break;
            }
        }
    }

    Ok(GlobResult {
        files,
        truncated,
        stamps: if want_stamps { Some(stamps) } else { None },
    })
}

// ── tests ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_keeps_brace_groups_intact() {
        // A plain comma list still splits.
        assert_eq!(split_glob_list("*.js, *.ts"), vec!["*.js", "*.ts"]);
        // Commas INSIDE braces must NOT split — this is the common
        // `*.{js,ts,rs,json,md,svelte}` form that used to break.
        assert_eq!(
            split_glob_list("*.{js,ts,rs,json,md,svelte}"),
            vec!["*.{js,ts,rs,json,md,svelte}"]
        );
        // Mixed: brace group first, then another pattern.
        assert_eq!(
            split_glob_list("*.{js,ts},src/**/*.rs"),
            vec!["*.{js,ts}", "src/**/*.rs"]
        );
        // Unbalanced brace: no crash, treated as one piece.
        assert_eq!(split_glob_list("*.{js,ts"), vec!["*.{js,ts"]);
        // Empty pieces are dropped.
        assert_eq!(split_glob_list(""), Vec::<String>::new());
        assert_eq!(split_glob_list(",, *.js ,"), vec!["*.js"]);
    }

    #[test]
    fn globset_accepts_brace_alternation() {
        // globset natively supports `{a,b}` alternation — prove the common
        // include_glob form is a VALID glob, not something we must expand.
        let g = Glob::new("*.{js,ts,rs,json,md,svelte}").expect("brace glob compiles");
        let m = g.compile_matcher();
        assert!(m.is_match("index.js"));
        assert!(m.is_match("lib.ts"));
        assert!(m.is_match("main.rs"));
        assert!(m.is_match("cfg.json"));
        assert!(m.is_match("README.md"));
        assert!(m.is_match("App.svelte"));
        assert!(!m.is_match("index.py"));
    }
}

// ── delete_file ───────────────────────────────────────────────────────────────

/// Delete a single file. Refuses to delete directories — use delete_dir for those.
#[tauri::command]
pub async fn delete_file(path: String, guard: tauri::State<'_, PathGuard>) -> Result<(), String> {
    guard.ensure_allowed(&path)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if p.is_dir() {
        return Err(format!(
            "Path is a directory, not a file: {} (use delete_dir for directories)",
            path
        ));
    }
    std::fs::remove_file(p).map_err(|e| format!("Failed to delete {}: {}", path, e))
}

// ── move_file ─────────────────────────────────────────────────────────────────

/// Rename or move a file/directory. Creates any missing parent directories of `to`.
/// Refuses to overwrite an existing destination unless `overwrite` is true.
#[tauri::command]
pub async fn move_file(
    from: String,
    to: String,
    overwrite: Option<bool>,
    guard: tauri::State<'_, PathGuard>,
) -> Result<(), String> {
    // Both the source (being removed) and destination (being created) must be
    // inside allowed roots.
    guard.ensure_allowed(&from)?;
    guard.ensure_allowed(&to)?;
    let src = Path::new(&from);
    let dst = Path::new(&to);
    if !src.exists() {
        return Err(format!("Source does not exist: {}", from));
    }
    if dst.exists() && !overwrite.unwrap_or(false) {
        return Err(format!(
            "Destination already exists: {} (pass overwrite=true to replace)",
            to
        ));
    }
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dir for {}: {}", to, e))?;
        }
    }
    std::fs::rename(src, dst).map_err(|e| format!("Failed to move {} → {}: {}", from, to, e))
}
