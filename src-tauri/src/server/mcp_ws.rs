// server/mcp_ws.rs — inbound MCP-over-WebSocket endpoint (Part A / T1).
//
// An external app (JHEditor/JHER/…) dials `GET /mcp/ws?app=<name>&token=<tok>`
// and speaks the MCP **server** role (tool provider) over the connection; JHAI
// is the MCP **client**. WebSocket is full-duplex, so JHAI sends `tools/call`
// over the line the app opened.
//
// This handler is a thin bridge (mirrors the stdio bridge in commands/mcp.rs):
//   • on connect  → register an outbound channel in McpWsState, emit
//                    `mcp-ws-connected` { app, connId } so the JS McpManager
//                    creates an McpWsClient and runs the MCP handshake.
//   • app→JHAI    → each text frame is re-emitted as `mcp-ws-recv-{connId}`.
//   • JHAI→app    → `mcp_ws_send` command pushes frames via the channel here.
//   • on close    → emit `mcp-ws-closed-{connId}` and deregister.

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Query, State},
    response::IntoResponse,
    http::StatusCode,
};
use serde::Deserialize;
use futures_util::{sink::SinkExt, stream::StreamExt};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use crate::server::router::AppState;
use crate::commands::mcp::{McpWsState, WsOut};

#[derive(Debug, Deserialize)]
pub struct McpWsQuery {
    pub app: String,
    pub token: String,
}

pub async fn mcp_ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<McpWsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if q.token != state.auth_token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, q.app, state))
}

async fn handle_socket(socket: WebSocket, app_name: String, state: AppState) {
    let (mut ws_sender, mut receiver) = socket.split();

    let conn_id = format!(
        "mcpws_{}_{}",
        app_name,
        chrono::Local::now().timestamp_millis()
    );

    // Outbound channel: `mcp_ws_send` → here → socket.
    let (tx, mut rx) = mpsc::unbounded_channel::<WsOut>();

    // Register in the managed McpWsState (reachable from the Tauri command side).
    {
        let ws_state = state.app_handle.state::<McpWsState>();
        ws_state.conns.lock().await.insert(conn_id.clone(), tx);
    }

    // Tell the JS layer a new app connected → it builds an McpWsClient + handshake.
    let _ = state.app_handle.emit(
        "mcp-ws-connected",
        serde_json::json!({ "app": app_name, "connId": conn_id }),
    );

    // Writer task: drain outbound channel → socket.
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                WsOut::Text(t) => {
                    if ws_sender.send(Message::Text(t)).await.is_err() {
                        break;
                    }
                }
                WsOut::Close => {
                    let _ = ws_sender.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    // Reader loop: app→JHAI frames → Tauri events.
    let app_handle = state.app_handle.clone();
    let recv_event = format!("mcp-ws-recv-{}", conn_id);
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(t) => {
                let _ = app_handle.emit(&recv_event, &t);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup: stop writer, deregister, notify JS.
    writer.abort();
    {
        let ws_state = state.app_handle.state::<McpWsState>();
        ws_state.conns.lock().await.remove(&conn_id);
    }
    let _ = state
        .app_handle
        .emit(&format!("mcp-ws-closed-{}", conn_id), 0i32);
}
