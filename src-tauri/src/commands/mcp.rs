use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

enum Msg {
    Write(String),
    Kill,
}

pub(crate) struct Handle {
    tx: mpsc::UnboundedSender<Msg>,
}

pub struct McpState {
    pub processes: Arc<Mutex<HashMap<String, Handle>>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Spawn an MCP server process and wire up stdin/stdout/stderr.
///
/// stdout lines are emitted as `mcp-stdout-{process_id}` events.
/// stderr lines are emitted as `mcp-stderr-{process_id}` events.
/// Process exit is emitted as `mcp-exit-{process_id}` (payload: exit code i32).
#[tauri::command]
pub async fn mcp_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, McpState>,
    process_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    // On Windows, spawn via PowerShell so .cmd/.bat extension resolution works
    // without showing a console window. powershell.exe respects CREATE_NO_WINDOW
    // more reliably than cmd.exe /c, and handles PATH resolution for npx, uvx, etc.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // Build a quoted command string for PowerShell -Command
        let ps_parts: Vec<String> = std::iter::once(command.clone())
            .chain(args.iter().cloned())
            .map(|a| {
                if a.contains(' ') || a.contains('"') {
                    format!("\"{}\"", a.replace('"', "\\\""))
                } else {
                    a
                }
            })
            .collect();
        let ps_cmd = ps_parts.join(" ");
        let mut c = Command::new("powershell.exe");
        c.arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg(&ps_cmd);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&command);
        c.args(&args);
        c
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    for (k, v) in &env {
        cmd.env(k, v);
    }

    // Suppress the console window on Windows
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", command, e))?;

    let mut stdin = child.stdin.take().ok_or("stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("stderr unavailable")?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();

    // Stdin writer + kill controller
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Write(data) => {
                    if stdin.write_all(data.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Msg::Kill => {
                    let _ = child.kill().await;
                    break;
                }
            }
        }
        // child is dropped here → kill_on_drop kills process if still alive
    });

    // Stdout reader → events
    let pid = process_id.clone();
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app2.emit(&format!("mcp-stdout-{}", pid), &line);
        }
        let _ = app2.emit(&format!("mcp-exit-{}", pid), 0i32);
    });

    // Stderr reader → events
    let pid = process_id.clone();
    let app3 = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app3.emit(&format!("mcp-stderr-{}", pid), &line);
        }
    });

    state
        .processes
        .lock()
        .await
        .insert(process_id, Handle { tx });

    Ok(())
}

/// Write a line to the MCP server's stdin.
#[tauri::command]
pub async fn mcp_write(
    state: State<'_, McpState>,
    process_id: String,
    data: String,
) -> Result<(), String> {
    let procs = state.processes.lock().await;
    let handle = procs
        .get(&process_id)
        .ok_or_else(|| format!("MCP process '{}' not found", process_id))?;
    handle
        .tx
        .send(Msg::Write(data))
        .map_err(|e| e.to_string())
}

/// Kill the MCP server process.
#[tauri::command]
pub async fn mcp_kill(
    state: State<'_, McpState>,
    process_id: String,
) -> Result<(), String> {
    let procs = state.processes.lock().await;
    if let Some(handle) = procs.get(&process_id) {
        let _ = handle.tx.send(Msg::Kill);
    }
    drop(procs);
    state.processes.lock().await.remove(&process_id);
    Ok(())
}

// ── MCP over inbound WebSocket (Part A / T1) ────────────────────────────────
// An external app dials JHAI's `/mcp/ws?app=<name>` and acts as the MCP SERVER
// (tool provider) over that connection; JHAI is the MCP CLIENT. The axum WS
// handler (server/mcp_ws.rs) bridges raw frames ↔ the JS layer EXACTLY like the
// stdio bridge above: incoming frames → `mcp-ws-recv-{conn_id}` Tauri events;
// the JS McpWsClient sends frames out via `mcp_ws_send`. This keeps all MCP
// JSON-RPC logic in JS and reuses the existing event/command plumbing.

/// Outbound message for a bridged MCP WebSocket connection.
pub enum WsOut {
    Text(String),
    Close,
}

/// Registry of live inbound MCP WS connections: conn_id → sender to its socket.
pub struct McpWsState {
    pub conns: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<WsOut>>>>,
}

impl Default for McpWsState {
    fn default() -> Self {
        Self {
            conns: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Send one JSON-RPC frame to a bridged MCP WS connection (JS → app).
#[tauri::command]
pub async fn mcp_ws_send(
    state: State<'_, McpWsState>,
    conn_id: String,
    data: String,
) -> Result<(), String> {
    let conns = state.conns.lock().await;
    let tx = conns
        .get(&conn_id)
        .ok_or_else(|| format!("MCP WS connection '{}' not found", conn_id))?;
    tx.send(WsOut::Text(data)).map_err(|e| e.to_string())
}

/// Close a bridged MCP WS connection.
#[tauri::command]
pub async fn mcp_ws_close(
    state: State<'_, McpWsState>,
    conn_id: String,
) -> Result<(), String> {
    let conns = state.conns.lock().await;
    if let Some(tx) = conns.get(&conn_id) {
        let _ = tx.send(WsOut::Close);
    }
    Ok(())
}
