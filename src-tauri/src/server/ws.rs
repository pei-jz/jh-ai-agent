use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Query, State},
    response::IntoResponse,
    http::StatusCode,
};
use serde::Deserialize;
use futures_util::{sink::SinkExt, stream::StreamExt};
use tauri::Emitter;
use chrono::Local;
use crate::server::router::AppState;

#[derive(Debug, Deserialize)]
pub struct WsAuth {
    pub token: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(auth): Query<WsAuth>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if auth.token != state.auth_token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let exists = {
        let tasks = state.tasks.lock().unwrap();
        tasks.contains_key(&id)
    };

    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, id, state))
}

async fn handle_socket(socket: WebSocket, task_id: String, state: AppState) {
    let (mut ws_sender, mut receiver) = socket.split();

    // ── Subscribe to the broadcast channel FIRST (race-fix) ──────────────
    // Previously we read the task status/logs snapshot and THEN subscribed.
    // For a fast task (e.g. a single_shot FK suggestion that finishes in ~1s),
    // the `complete` event could fire in the gap between the snapshot and the
    // subscribe call: it was absent from the (already-cloned) stored_logs AND
    // lost by the not-yet-created subscription (whose sender is removed on the
    // terminal event). The client then hung until its timeout.
    //
    // Subscribing BEFORE snapshotting guarantees the terminal event is captured
    // by EITHER the replay (if it landed in logs before our snapshot) OR the live
    // relay (if it fired after). Any event in the small overlap is delivered twice,
    // which is harmless: the client settles on the first `complete`/`error`.
    let rx = {
        let senders = state.task_senders.lock().unwrap();
        senders.get(&task_id).map(|tx| tx.subscribe())
    };

    // Check task status and get stored logs for replay (snapshot AFTER subscribe).
    let (mut stored_logs, is_done) = {
        let tasks = state.tasks.lock().unwrap();
        match tasks.get(&task_id) {
            Some(task) => {
                let done = matches!(task.status.as_str(), "completed" | "failed" | "aborted");
                (task.logs.clone(), done)
            }
            None => (vec![], true),
        }
    };

    // After an app restart the task is restored from `task_history.json` with
    // an empty logs vec. If memory is empty but a sidecar file exists, load
    // the persisted logs so the WS replay still works for old completed tasks.
    if stored_logs.is_empty() {
        let disk_logs = crate::load_task_logs(&state.history_path, &task_id);
        if !disk_logs.is_empty() {
            stored_logs = disk_logs;
        }
    }

    // If the task already finished AND nothing is left to relay, we replay then close.
    // Otherwise we keep the (already-created) subscription to relay live events.
    let rx = if is_done { None } else { rx };

    // Replay stored logs to the client — SLIMMED: per-step CHAT entries embed
    // the full conversation history/system prompt (O(steps²) bytes total),
    // which made replay of long tasks the dominant selection cost. The client
    // fetches a step's full payload on demand via GET /tasks/:id/logs/:idx.
    for (i, log_entry) in stored_logs.iter().enumerate() {
        let slim = crate::server::router::slim_log_entry(log_entry, i);
        if let Ok(msg_str) = serde_json::to_string(&slim) {
            if ws_sender.send(Message::Text(msg_str)).await.is_err() {
                return;
            }
        }
    }

    // Replay-complete marker: lets the client buffer the whole backlog and
    // render it in ONE batch instead of per-event DOM insertion. Old clients
    // ignore this event; new clients also have a debounce fallback for old
    // backends that don't send it.
    let done_marker = serde_json::json!({
        "event": "replay_done",
        "data": { "count": stored_logs.len() },
        "timestamp": Local::now().to_rfc3339()
    });
    if let Ok(msg_str) = serde_json::to_string(&done_marker) {
        if ws_sender.send(Message::Text(msg_str)).await.is_err() {
            return;
        }
    }

    // If task is already done, close the connection after replay
    if is_done {
        return;
    }

    // Spawn relay thread for live events from broadcast channel
    let relay_handle = tokio::spawn(async move {
        if let Some(mut rx) = rx {
            while let Ok(msg_str) = rx.recv().await {
                if ws_sender.send(Message::Text(msg_str)).await.is_err() {
                    break;
                }
            }
        }
    });

    // Listen for steering / confirmation messages from the client
    let app_handle = state.app_handle.clone();
    let task_id_clone = task_id.clone();

    while let Some(Ok(message)) = receiver.next().await {
        if let Message::Text(text) = message {
            if let Ok(client_event) = serde_json::from_str::<serde_json::Value>(&text) {
                let event_name = client_event["event"].as_str().unwrap_or("");

                match event_name {
                    "abort" => {
                        relay_handle.abort();
                        let _ = app_handle.emit("abort-task", serde_json::json!({ "taskId": task_id_clone }));
                        break;
                    }
                    "confirm_response" => {
                        if let Some(payload) = client_event.get("data") {
                            // 1. Route to TaskBridge so the waiting agent receives the answer.
                            let _ = app_handle.emit("confirm-response", payload.clone());

                            // 2. Re-broadcast a `confirm_resolved` event to every WS client
                            //    of this task. This lets the OTHER client (e.g. JHEditor
                            //    when this client is the JHAI Monitor, or vice versa)
                            //    update its UI so the dangling Approve/Reject buttons
                            //    don't sit there pretending the request is still pending.
                            let resolved_packet = serde_json::json!({
                                "event": "confirm_resolved",
                                "data": payload,
                                "timestamp": Local::now().to_rfc3339()
                            });
                            if let Ok(msg) = serde_json::to_string(&resolved_packet) {
                                let senders = state.task_senders.lock().unwrap();
                                if let Some(tx) = senders.get(&task_id_clone) {
                                    let _ = tx.send(msg);
                                }
                            }
                        }
                    }
                    "steering" => {
                        if let Some(data) = client_event.get("data") {
                            if let Some(msg) = data.get("message").and_then(|m| m.as_str()) {
                                let images = data.get("images").map(|i| i.clone());
                                let _ = app_handle.emit("steering-task", serde_json::json!({
                                    "taskId": task_id_clone,
                                    "message": msg,
                                    "images": images
                                }));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    relay_handle.abort();
}
