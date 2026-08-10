// git.rs — Dedicated, permission-aware Git tools for the agent.
//
// These wrap the `git` CLI as a subprocess (no libgit2 dependency — keeps the
// binary light and inherits the user's git config/credentials). Unlike sending
// git through the generic run_command tool, these are first-class tools with
// clear read/write semantics so the frontend permission model can Allow the
// read-only ones (status/diff/log) without prompting and only gate the
// mutating one (commit).
//
// Every command runs with `cwd` inside an allowed root, enforced by PathGuard
// (defense-in-depth — same backstop as run_command).

use tauri::State;

use crate::path_guard::PathGuard;

/// Run a git subcommand with `args` in `cwd`, returning trimmed stdout.
/// Non-zero exit surfaces stderr as the error message.
fn run_git(cwd: &str, args: &[&str], guard: &PathGuard) -> Result<String, String> {
    guard.ensure_allowed(cwd)?;

    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd);

    // Prevent a visible console window on Windows.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git (is it installed and on PATH?): {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim_end().to_string())
    } else {
        Err(format!(
            "git {} failed (exit {:?}): {}",
            args.first().unwrap_or(&""),
            output.status.code(),
            if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
        ))
    }
}

/// Working-tree status. Uses porcelain v2 with branch info for a stable,
/// machine-readable summary the LLM can parse reliably.
#[tauri::command]
pub async fn git_status(cwd: String, guard: State<'_, PathGuard>) -> Result<String, String> {
    run_git(&cwd, &["status", "--porcelain=v2", "--branch"], &guard)
}

/// Show changes. `staged` selects --cached (index vs HEAD); otherwise working
/// tree vs index. `path` optionally limits the diff to one file.
#[tauri::command]
pub async fn git_diff(
    cwd: String,
    staged: Option<bool>,
    path: Option<String>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    if let Some(p) = path.as_deref() {
        if !p.is_empty() {
            args.push("--");
            args.push(p);
        }
    }
    run_git(&cwd, &args, &guard)
}

/// Recent commit history, one per line: "<short-hash> <subject> (<relative-time>)".
#[tauri::command]
pub async fn git_log(
    cwd: String,
    max_count: Option<u32>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    let n = max_count.unwrap_or(20).clamp(1, 200).to_string();
    run_git(
        &cwd,
        &[
            "log",
            &format!("--max-count={}", n),
            "--pretty=format:%h %s (%ar)",
        ],
        &guard,
    )
}

/// Stage the given paths (or all changes when empty) and create a commit.
/// This is the only MUTATING git tool — the frontend gates it behind Ask.
#[tauri::command]
pub async fn git_commit(
    cwd: String,
    message: String,
    paths: Option<Vec<String>>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("git_commit requires a non-empty message".to_string());
    }

    // Stage: either explicit paths or everything.
    match paths.as_deref() {
        Some(ps) if !ps.is_empty() => {
            let mut add_args: Vec<&str> = vec!["add", "--"];
            add_args.extend(ps.iter().map(|s| s.as_str()));
            run_git(&cwd, &add_args, &guard)?;
        }
        _ => {
            run_git(&cwd, &["add", "-A"], &guard)?;
        }
    }

    run_git(&cwd, &["commit", "-m", message.trim()], &guard)
}
