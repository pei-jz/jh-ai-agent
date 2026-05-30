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
        for piece in g.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let glob = Glob::new(piece)
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

#[derive(Debug, Serialize)]
pub struct GlobResult {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// List files under `path` matching a glob pattern (e.g. "**/*.test.js").
/// Respects .gitignore by default.
///
/// Arguments:
///   pattern     - glob pattern. Use `**` for arbitrary directories, `*` for any chars within
///                 a single segment. Examples: "*.md", "src/**/*.ts", "**/*test*"
///   path        - root to search (absolute). Default: current working dir.
///   max_results - default 500. Hard cap 5000.
#[tauri::command]
pub async fn glob_files(
    pattern: String,
    path: Option<String>,
    max_results: Option<usize>,
) -> Result<GlobResult, String> {
    if pattern.trim().is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    let root = path.unwrap_or_else(|| ".".to_string());
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Glob root does not exist: {}", root));
    }
    let max_results = max_results.unwrap_or(500).min(5000);

    let glob = Glob::new(&pattern)
        .map_err(|e| format!("Invalid glob '{}': {}", pattern, e))?;
    let matcher = glob.compile_matcher();

    let mut files: Vec<String> = Vec::new();
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
            files.push(p.to_string_lossy().into_owned());
            if files.len() >= max_results {
                truncated = true;
                break;
            }
        }
    }

    Ok(GlobResult { files, truncated })
}

// ── delete_file ───────────────────────────────────────────────────────────────

/// Delete a single file. Refuses to delete directories — use delete_dir for those.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
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
) -> Result<(), String> {
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
