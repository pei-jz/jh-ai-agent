use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

/// How long a command may run before it is killed.
///
/// There was no limit at all, and nothing redirected stdin. A command that waits for
/// input it can never receive — an npm prompt, a pager, a confirmation, a watch-mode
/// test runner — blocked the agent loop forever. From the outside that is exactly the
/// reported symptom: the run sits on one step and never advances, with no error.
///
/// Ten minutes is chosen to be longer than a real build or test suite and shorter than
/// a human's patience. A caller that genuinely needs longer passes `timeout_secs`.
const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// Wait for `child`, killing it if `limit` elapses first.
///
/// Polling with `try_wait` rather than blocking on `wait`, because the whole point is
/// to be able to give up. 50ms keeps a fast command feeling instant while costing
/// nothing measurable on a long one.
fn wait_with_timeout(child: &mut Child, limit: Duration) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to wait for command: {}", e)),
        }
        if started.elapsed() >= limit {
            // Kill, then reap: leaving a zombie would hold the pipes open and the
            // line pumps would never see EOF.
            let _ = child.kill();
            let _ = child.wait();
            return Err(String::from("__TIMEOUT__"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// The error text a timeout produces.
///
/// Written for the agent as much as the user: it says what to do next, because a
/// model that only learns "it failed" will retry the identical hanging command.
fn timeout_error(command: &str, secs: u64, stdout: &str, stderr: &str) -> String {
    format!(
        "Command timed out after {secs}s and was killed: {command}\n\
         The most likely cause is that it waited for input (stdin is closed, so any \
         prompt sees EOF) or that it does not terminate on its own (a watch mode, a \
         dev server, an interactive tool). Re-run it with a non-interactive / \
         run-once flag, or split it into something that finishes.\n\
         Partial stdout:\n{stdout}\nPartial stderr:\n{stderr}"
    )
}

/// One chunk of streamed command output. Emitted as "command-chunk" while a
/// streamed run_command is executing. Listeners filter by `command_id` to
/// associate chunks with the right tool call.
#[derive(Serialize, Clone)]
pub struct CommandChunk {
    pub command_id: String,
    pub stream: String, // "stdout" or "stderr"
    pub line: String,
}

/// What `run_command` actually spawns.
///
/// The agent was writing bash for a PowerShell host and only discovering the
/// mismatch from the error, wasting a step on nearly every command. The tool
/// description is now generated from this — and this is the SAME function the
/// spawn uses, so the description cannot drift from the truth.
#[derive(Serialize, Clone)]
pub struct ShellInfo {
    /// "windows" | "macos" | "linux" | …
    pub os: String,
    /// Program that is executed, e.g. "powershell".
    pub program: String,
    /// Fixed arguments placed before the command string.
    pub args: Vec<String>,
    /// Human-readable name for the prompt, e.g. "Windows PowerShell 5.1".
    pub display: String,
}

/// Single source of truth for the shell: `(program, leading args)`.
fn shell_spec() -> (&'static str, &'static [&'static str]) {
    if cfg!(target_os = "windows") {
        // powershell.exe is Windows PowerShell 5.1 — NOT pwsh 7, which is why
        // `&&`, `??` and the ternary operator are unavailable.
        ("powershell", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
    } else {
        // POSIX sh, not bash: bashisms like [[ ]] and arrays may not work.
        ("sh", &["-c"])
    }
}

pub fn shell_info() -> ShellInfo {
    let (program, args) = shell_spec();
    ShellInfo {
        os: std::env::consts::OS.to_string(),
        program: program.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        display: if cfg!(target_os = "windows") {
            "Windows PowerShell 5.1 (powershell.exe)".to_string()
        } else {
            "POSIX sh".to_string()
        },
    }
}

/// Report the shell the agent's commands will run in, so its tool description
/// can state the truth instead of the model guessing.
#[tauri::command]
pub fn get_shell_info() -> ShellInfo {
    shell_info()
}

/// Execute a shell command and return its combined stdout on success.
///
/// Streaming behavior:
///   • When `command_id` is provided (non-empty), each line of stdout/stderr is
///     emitted live as a "command-chunk" event with that id, so the UI can
///     show progress instead of waiting until completion.
///   • When `command_id` is None or empty, the function behaves as a simple
///     buffered call (no events emitted) — backward compatible.
///
/// On non-zero exit, returns Err("Command failed:\nStdout: ...\nStderr: ...").
#[tauri::command]
pub async fn run_command<R: Runtime>(
    command: String,
    cwd: Option<String>,
    command_id: Option<String>,
    // timeout_secs overrides DEFAULT_TIMEOUT_SECS. 0 is rejected rather than taken as
    // "no limit": an unbounded command is the bug this parameter exists to fix.
    timeout_secs: Option<u64>,
    app: AppHandle<R>,
    guard: tauri::State<'_, crate::path_guard::PathGuard>,
) -> Result<String, String> {
    // Defense-in-depth: a shell command runs with `cwd` as its working
    // directory. Require that directory to be inside an allowed root so the
    // backend won't execute commands rooted in arbitrary locations. (The
    // command string itself is still gated by the frontend's confirmation
    // flow; this is a backstop, not a sandbox.)
    if let Some(dir) = cwd.as_ref() {
        if !dir.is_empty() {
            guard.ensure_allowed(dir)?;
        }
    }

    let limit = Duration::from_secs(
        timeout_secs.filter(|s| *s > 0).unwrap_or(DEFAULT_TIMEOUT_SECS),
    );

    // Everything below BLOCKS: spawning, polling the child, draining pipes. An
    // `async fn` command runs on Tauri's Tokio runtime, so doing that work inline
    // parks a runtime worker for the whole duration of the command. A few slow or
    // hung commands were therefore enough to starve the worker pool — and once that
    // happens EVERY other Tauri command stops being serviced, which looks from the
    // outside like the entire agent freezing mid-run rather than like one slow shell
    // call. spawn_blocking puts it on the blocking pool, where waiting is the point.
    tokio::task::spawn_blocking(move || run_command_blocking(command, cwd, command_id, limit, app))
        .await
        .map_err(|e| format!("Command task failed to run: {}", e))?
}

/// The blocking body of `run_command`. See the spawn_blocking note above.
fn run_command_blocking<R: Runtime>(
    command: String,
    cwd: Option<String>,
    command_id: Option<String>,
    limit: Duration,
    app: AppHandle<R>,
) -> Result<String, String> {
    // Same spec the description is generated from — see shell_spec().
    #[allow(unused_mut)]
    let mut cmd = {
        let (program, args) = shell_spec();
        let mut c = Command::new(program);
        c.args(args);
        c.arg(&command);
        // Close stdin. Inherited, a child that prompts blocks on a terminal that
        // does not exist and hangs the agent forever; with a null stdin it reads EOF
        // and either takes its default or fails with something the agent can react
        // to. (PowerShell gets -NonInteractive, but that does not cover processes it
        // launches, and `sh -c` has no equivalent flag at all.)
        c.stdin(Stdio::null());
        c
    };

    if let Some(dir) = cwd.as_ref() {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    // Prevent a visible console window from appearing on Windows.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let streaming = command_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false);

    // ── Buffered (non-streaming) fast path ──────────────────────────────
    if !streaming {
        // Piped rather than inherited so a timeout can still report what was
        // produced before the kill — partial output is often the whole diagnosis.
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        let out_handle = child.stdout.take().map(|p| thread::spawn(move || read_all(p)));
        let err_handle = child.stderr.take().map(|p| thread::spawn(move || read_all(p)));

        let status = wait_with_timeout(&mut child, limit);
        let stdout = out_handle.and_then(|h| h.join().ok()).unwrap_or_default();
        let stderr = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        return match status {
            Ok(st) if st.success() => Ok(stdout),
            Ok(_) => Err(format!(
                "Command failed:\nStdout: {}\nStderr: {}",
                stdout, stderr
            )),
            Err(e) if e == "__TIMEOUT__" => {
                Err(timeout_error(&command, limit.as_secs(), &stdout, &stderr))
            }
            Err(e) => Err(e),
        };
    }

    // ── Streaming path ───────────────────────────────────────────────────
    let cmd_id = command_id.unwrap_or_default();
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let (tx, rx) = mpsc::channel::<(&'static str, String)>();

    spawn_line_pump("stdout", stdout, tx.clone());
    spawn_line_pump("stderr", stderr, tx.clone());
    drop(tx); // close the original sender so the rx loop terminates when both pumps finish

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let started = Instant::now();
    // recv_timeout rather than an unbounded iterator: a command that hangs without
    // producing output would otherwise park here for good.
    loop {
        let remaining = limit.checked_sub(started.elapsed()).unwrap_or_default();
        let received = if remaining.is_zero() {
            Err(mpsc::RecvTimeoutError::Timeout)
        } else {
            rx.recv_timeout(remaining)
        };

        let (stream, line) = match received {
            Ok(v) => v,
            // Both pumps hit EOF: the process closed its pipes and we are done reading.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(timeout_error(
                    &command,
                    limit.as_secs(),
                    &stdout_buf,
                    &stderr_buf,
                ));
            }
        };

        // Emit to the UI as it arrives.
        let _ = app.emit(
            "command-chunk",
            CommandChunk {
                command_id: cmd_id.clone(),
                stream: stream.to_string(),
                line: line.clone(),
            },
        );
        // Also accumulate for the final return value.
        if stream == "stdout" {
            stdout_buf.push_str(&line);
            stdout_buf.push('\n');
        } else {
            stderr_buf.push_str(&line);
            stderr_buf.push('\n');
        }
    }

    // The pipes are closed, but the process may still be finishing; bound this too.
    let status = match wait_with_timeout(&mut child, limit.saturating_sub(started.elapsed())) {
        Ok(st) => st,
        Err(e) if e == "__TIMEOUT__" => {
            return Err(timeout_error(&command, limit.as_secs(), &stdout_buf, &stderr_buf));
        }
        Err(e) => return Err(e),
    };

    if status.success() {
        Ok(stdout_buf)
    } else {
        Err(format!(
            "Command failed:\nStdout: {}\nStderr: {}",
            stdout_buf, stderr_buf
        ))
    }
}

/// Drain a pipe to a String, lossily. On its own thread so a child that fills its
/// pipe buffer cannot deadlock against our wait.
fn read_all<R: Read>(mut reader: R) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let _ = reader.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Spawn a background thread that reads `reader` line-by-line and forwards each
/// line over `tx`. Uses lossy UTF-8 conversion so non-UTF8 (Windows codepage)
/// output is preserved rather than dropped.
fn spawn_line_pump<R: Read + Send + 'static>(
    stream: &'static str,
    reader: R,
    tx: mpsc::Sender<(&'static str, String)>,
) {
    thread::spawn(move || {
        let mut buf_reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::with_capacity(1024);
        loop {
            buf.clear();
            match buf_reader.read_until(b'\n', &mut buf) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    // Strip the trailing newline (and \r on Windows) before sending.
                    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                        buf.pop();
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    if tx.send((stream, line)).is_err() {
                        break; // receiver dropped — bail
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// Open a file or folder with the OS default application (chosen by the OS from
/// the file extension). Used by the "execution result" file links in the UI so
/// clicking a created/modified file opens it like a double-click in Explorer.
///
/// This is intentionally a thin wrapper over the opener plugin: opening (reading)
/// is unrestricted in this app's security model, and the action is always
/// user-initiated (a click on a path the agent itself produced).
#[tauri::command]
pub fn open_path_default<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // Normalize separators to the OS-native form. The UI stores paths with
    // forward slashes (resolvePath normalizes to '/'), but Windows Explorer's
    // reveal ("/select,") — the fallback for extensions with no default app
    // like .md — only accepts BACKSLASHES. Without this, clicking a .md link
    // silently no-ops (open fails on no-association, then reveal fails on the
    // forward-slash path). See report: "link visible but clicking does nothing".
    #[cfg(windows)]
    let path = path.replace('/', "\\");

    // Try the OS default application first (double-click behavior).
    match app.opener().open_path(path.clone(), None::<&str>) {
        Ok(()) => Ok(()),
        Err(e) => {
            // The association-based open failed. Most common on Windows for
            // extensions with NO default app (e.g. .md → "no application found"),
            // or when the user cancels the "Open with" dialog (os error 1223).
            // Fall back to REVEALING the file in the OS file manager (Explorer /
            // Finder) so the click still lands the user on the file. Reveal does
            // not depend on a file association, so it works for any extension.
            match app.opener().reveal_item_in_dir(&path) {
                Ok(()) => Ok(()),
                Err(e2) => Err(format!(
                    "Failed to open path: {} (reveal-in-folder fallback also failed: {})",
                    e, e2
                )),
            }
        }
    }
}

/// AppUserModelID used for our Windows toast notifications. Must match the id
/// registered in the registry by `register_notification_identity()` so Windows
/// shows "J.H AI Agent" (name + icon) as the toast source instead of falling
/// back to "Windows PowerShell".
///
/// This is the SAME string as `identifier` in tauri.conf.json, and it has to
/// be: for an installed build the AppUserModelID Windows knows the app by IS
/// the bundle identifier. A copy in two places drifts silently — the toast
/// keeps working in dev (where this registers its own key) and loses its name
/// and icon only once installed. `identifier_matches_bundle` below is the
/// guard.
#[cfg(windows)]
pub const NOTIFY_APP_ID: &str = "io.github.pei-jz.jhaiagent";

/// Register our AppUserModelID → DisplayName mapping (HKCU, no elevation).
/// Without this, an unpackaged exe (target\debug|release — the dev workflow)
/// has no registered identity, so tauri-plugin-notification's fallback makes
/// every toast appear as "Windows PowerShell". Idempotent; call once at setup.
#[cfg(windows)]
pub fn register_notification_identity() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let key = format!(r"HKCU\Software\Classes\AppUserModelId\{}", NOTIFY_APP_ID);
    let _ = Command::new("reg")
        .args(["add", &key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "J.H AI Agent", "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
pub fn register_notification_identity() {}

/// OS toast notification with a proper app identity. We bypass the
/// tauri-plugin-notification path for the toast itself because the plugin only
/// sets the AppUserModelID when the exe is NOT under target\debug|release —
/// i.e. in dev/portable use every toast said "Windows PowerShell".
#[tauri::command]
pub fn os_notify(title: String, body: String) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.summary(&title).body(&body);
    #[cfg(windows)]
    {
        n.app_id(NOTIFY_APP_ID);
    }
    n.show().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::NOTIFY_APP_ID;

    /// The toast identity and the bundle identity are one identity.
    ///
    /// Nothing at runtime compares them. An installed build with a mismatched
    /// AppUserModelID still shows toasts — under whatever name Windows can
    /// find, which is the fallback this constant exists to avoid.
    #[test]
    fn identifier_matches_bundle() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"].as_str().unwrap(), NOTIFY_APP_ID);
    }
}
