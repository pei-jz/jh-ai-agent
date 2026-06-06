use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use tauri::{AppHandle, Emitter, Runtime};

/// One chunk of streamed command output. Emitted as "command-chunk" while a
/// streamed run_command is executing. Listeners filter by `command_id` to
/// associate chunks with the right tool call.
#[derive(Serialize, Clone)]
pub struct CommandChunk {
    pub command_id: String,
    pub stream: String, // "stdout" or "stderr"
    pub line: String,
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
    #[allow(unused_mut)]
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("powershell");
        c.args(&[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(&["-c", &command]);
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
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute command: {}", e))?;
        let stdout = String::from_utf8(output.stdout.clone())
            .unwrap_or_else(|_| String::from_utf8_lossy(&output.stdout).to_string());
        let stderr = String::from_utf8(output.stderr.clone())
            .unwrap_or_else(|_| String::from_utf8_lossy(&output.stderr).to_string());
        return if output.status.success() {
            Ok(stdout)
        } else {
            Err(format!(
                "Command failed:\nStdout: {}\nStderr: {}",
                stdout, stderr
            ))
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
    for (stream, line) in rx.iter() {
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

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for command: {}", e))?;

    if status.success() {
        Ok(stdout_buf)
    } else {
        Err(format!(
            "Command failed:\nStdout: {}\nStderr: {}",
            stdout_buf, stderr_buf
        ))
    }
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
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Failed to open path: {}", e))
}
