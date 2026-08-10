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

// ── MCP over outbound Streamable HTTP (T2) ──────────────────────────────────
// JHAI connects OUT to a remote MCP server over HTTP (the "Streamable HTTP"
// transport, MCP spec 2025-03-26). The JS McpHttpClient keeps all JSON-RPC /
// session logic; this command is a thin reqwest bridge that POSTs one JSON-RPC
// message and returns the raw response body + status + content-type. Keeping
// the HTTP I/O in Rust avoids webview CORS limits and lets the JS layer reuse
// the exact same handshake/tool-discovery code as the stdio client.

/// Result of one HTTP round-trip to a remote MCP server.
#[derive(serde::Serialize)]
pub struct McpHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
    /// Value of the `mcp-session-id` response header, if present (stateful servers).
    pub session_id: Option<String>,
}

/// POST one JSON-RPC message to a remote MCP endpoint (Streamable HTTP).
///
/// `headers` are extra request headers (e.g. Authorization, MCP-Protocol-Version,
/// Mcp-Session-Id) supplied by the JS client. The bridge always sets Accept to
/// `application/json, text/event-stream` per the spec and Content-Type to JSON.
#[tauri::command]
pub async fn mcp_http_send(
    url: String,
    body: String,
    headers: Option<Vec<(String, String)>>,
) -> Result<McpHttpResponse, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("mcp_http_send: url must start with http:// or https://".to_string());
    }

    // ── SSRF hardening: forbid cross-host redirects ──────────────────────────
    // The endpoint is user-configured (trusted), but a redirect is attacker-
    // controllable by the remote: a 30x to http://169.254.169.254/ or
    // http://localhost/… would turn a benign config into a probe of internal
    // services. Allow redirects only when the target host is unchanged (path
    // canonicalisation, http→https on the same host); block any host change.
    let origin_host = reqwest::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string));
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > 5 {
            return attempt.error("too many redirects");
        }
        let same_host = attempt.url().host_str().map(str::to_string) == origin_host;
        if same_host { attempt.follow() } else { attempt.stop() }
    });

    let client = reqwest::Client::builder()
        .user_agent("JH-AI-Agent/McpHttpClient")
        .timeout(std::time::Duration::from_secs(60))
        .redirect(redirect_policy)
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .body(body);

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            if let Ok(name) = reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
                if let Ok(value) = reqwest::header::HeaderValue::from_str(&v) {
                    req = req.header(name, value);
                }
            }
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("mcp_http_send request failed: {}", e))?;

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading mcp_http_send response failed: {}", e))?;

    Ok(McpHttpResponse {
        status,
        content_type,
        body,
        session_id,
    })
}

// ── Browser worker provisioning (Phase 2) ───────────────────────────────────
// The Playwright worker (resources/browser_worker.mjs) is embedded in the
// binary with include_str! so it survives bundling (the Vite frontend bundle
// loses real file paths). On first use we write it to <config_dir>/browser/
// and hand the absolute path back to the JS BrowserBridge, which spawns it via
// mcp_spawn. Idempotent — subsequent calls just return the existing path.

/// Embedded Playwright worker source (kept in resources/ so it's editable).
const BROWSER_WORKER_SRC: &str = include_str!("../../resources/browser_worker.mjs");

/// Worker location + a base directory from which Node can resolve `playwright`.
#[derive(serde::Serialize)]
pub struct BrowserWorkerInfo {
    /// Absolute path to the materialised worker script.
    pub path: String,
    /// A directory containing `node_modules/playwright` (or None if not found).
    /// Passed to the worker as JHAI_PLAYWRIGHT_BASE so its createRequire anchor
    /// can resolve the package despite the worker living in the config dir.
    pub playwright_base: Option<String>,
}

#[cfg(test)]
mod playwright_base_tests {
    use super::find_playwright_base_from;

    #[test]
    fn finds_node_modules_playwright_walking_upward() {
        // <tmp>/proj/node_modules/playwright  +  <tmp>/proj/src/deep
        let base = std::env::temp_dir().join(format!("jhai_pw_{}", std::process::id()));
        let proj = base.join("proj");
        let deep = proj.join("src").join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(proj.join("node_modules").join("playwright")).unwrap();

        // From a nested dir, the walk should locate the project root.
        let found = find_playwright_base_from(&deep).expect("should find base");
        assert_eq!(
            std::fs::canonicalize(found).unwrap(),
            std::fs::canonicalize(&proj).unwrap()
        );

        // A sibling tree without node_modules/playwright yields None.
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        assert!(find_playwright_base_from(&other).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }
}

/// Search upward from `start` for a directory whose `node_modules/playwright`
/// exists. Returns that directory (the one CONTAINING node_modules).
fn find_playwright_base_from(start: &std::path::Path) -> Option<String> {
    let mut cur = start;
    loop {
        if cur.join("node_modules").join("playwright").is_dir() {
            return Some(cur.to_string_lossy().to_string());
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return None,
        }
    }
}

/// Best-effort discovery of a base dir that can resolve `playwright`, checking
/// the process working dir (covers `npm run tauri dev`) then the executable dir.
fn find_playwright_base() -> Option<String> {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(b) = find_playwright_base_from(&cwd) {
            return Some(b);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(b) = find_playwright_base_from(dir) {
                return Some(b);
            }
        }
    }
    None
}

/// Ensure the browser worker script exists on disk; return its path + a base
/// directory from which `playwright` can be resolved.
#[tauri::command]
pub async fn browser_worker_path<R: Runtime>(app: AppHandle<R>) -> Result<BrowserWorkerInfo, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("browser");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let path = dir.join("browser_worker.mjs");
    // (Re)write only when missing or stale so local edits to a deployed worker
    // aren't clobbered on every call.
    let stale = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != BROWSER_WORKER_SRC,
        Err(_) => true,
    };
    if stale {
        std::fs::write(&path, BROWSER_WORKER_SRC).map_err(|e| e.to_string())?;
    }
    Ok(BrowserWorkerInfo {
        path: path.to_string_lossy().to_string(),
        playwright_base: find_playwright_base(),
    })
}
