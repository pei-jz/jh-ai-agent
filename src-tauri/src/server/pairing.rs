// pairing — how an app on this machine gets a token, with a person in the loop.
//
// The old answer was a file. The agent wrote its token to
// %APPDATA%/JH/ai-connection.json and anything running as the user could read
// it: no approval, no record of who took it, and no way to take it back from
// one caller. This replaces that with a request the user answers.
//
//   1. The app POSTs /api/pair/request — the one unauthenticated route.
//   2. The agent identifies the PROCESS behind the socket (server/peer.rs) and
//      raises a prompt naming its executable.
//   3. The user approves; a token is minted into memory only (server/tokens.rs)
//      and bound to that process.
//   4. The app polls /api/pair/:id until it is answered, and holds the token in
//      memory too. Nothing is written down on either side.
//
// ── The code ──────────────────────────────────────────────────────────────
// The CLIENT generates a six-digit code and sends it with the request; the
// prompt displays it; the client displays it too. The user compares, they do
// not type.
//
// It is there for one specific attack. Without it, a background process can
// fire a pair request at the moment the user launches their editor — the prompt
// appears, it looks like the thing they just started, and they approve it. With
// it, the prompt shows a number that the editor's own window does not, and the
// mismatch is the tell. Comparison rather than transcription, because a code
// the user must type is friction they will route around, and pairing happens
// again after every agent restart.
//
// ── What an unauthenticated route must not become ─────────────────────────
// /api/pair/request is reachable by anything on this machine, which makes it a
// way to pop dialogs at the user until one is approved by reflex. Three limits:
// pending requests are capped, each expires, and a burst from the same process
// is refused rather than queued. A refusal here is a quiet 429 — not another
// dialog.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{extract::{ConnectInfo, Path, State}, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tauri::Emitter;

use crate::server::peer::{self, PeerInfo};
use crate::server::router::AppState;

/// How long an unanswered request stays on screen and in the map.
const REQUEST_TTL_SECS: u64 = 120;
/// How many requests may be pending at once, across all callers.
const MAX_PENDING: usize = 8;
/// A single caller may not open a new request this often.
const PER_PID_COOLDOWN_SECS: u64 = 10;

fn epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PairStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

#[derive(Debug, Clone)]
pub struct PairRequest {
    pub id: String,
    pub app: String,
    pub code: String,
    pub peer: Option<PeerInfo>,
    pub created_at: u64,
    pub status: PairStatus,
    /// Filled in on approval, read exactly once by the polling client.
    pub token: Option<String>,
}

#[derive(Default)]
pub struct PairingState {
    pending: Mutex<HashMap<String, PairRequest>>,
}

impl PairingState {
    /// Drop anything past its TTL. Called at the top of every operation rather
    /// than on a timer: the map is only interesting when someone touches it.
    fn expire(&self, map: &mut HashMap<String, PairRequest>) {
        let now = epoch_secs();
        map.retain(|_, r| {
            // An ANSWERED request is kept for the TTL too, so the client that is
            // polling gets its answer before the entry disappears. Removing it
            // the moment it was approved would show the client a 404 and it
            // would start the whole flow again — another dialog, for a pairing
            // that had just succeeded.
            now.saturating_sub(r.created_at) < REQUEST_TTL_SECS
        });
        for r in map.values_mut() {
            if r.status == PairStatus::Pending
                && now.saturating_sub(r.created_at) >= REQUEST_TTL_SECS
            {
                r.status = PairStatus::Expired;
            }
        }
    }

    pub fn list_pending(&self) -> Vec<PairRequest> {
        let mut map = match self.pending.lock() { Ok(m) => m, Err(_) => return Vec::new() };
        self.expire(&mut map);
        map.values().filter(|r| r.status == PairStatus::Pending).cloned().collect()
    }

    pub fn answer(&self, id: &str, approved: bool, token: Option<String>) -> bool {
        let mut map = match self.pending.lock() { Ok(m) => m, Err(_) => return false };
        match map.get_mut(id) {
            // Only a PENDING request may be answered. Without this a second
            // click on a stale dialog would mint a second token for a request
            // the user already settled.
            Some(r) if r.status == PairStatus::Pending => {
                r.status = if approved { PairStatus::Approved } else { PairStatus::Denied };
                r.token = token;
                true
            }
            _ => false,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PairRequestBody {
    /// What the app calls itself. Shown as a claim, beside the executable path,
    /// which is not a claim.
    pub app: String,
    /// Six digits the client also shows in its own window, for comparison.
    pub code: String,
}

#[derive(Debug, Serialize)]
pub struct PairRequestResponse {
    pub request_id: String,
    /// Seconds the user has to answer, so the client can show the same clock.
    pub expires_in: u64,
}

#[derive(Debug, Serialize)]
pub struct PairPollResponse {
    pub status: PairStatus,
    /// Present exactly when `status` is `approved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// POST /api/pair/request — the one route that needs no credential.
pub async fn request_pairing(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PairRequestBody>,
) -> Result<Json<PairRequestResponse>, StatusCode> {
    // A six-digit code is the contract with the client; anything else means the
    // caller is not speaking this protocol, and a prompt showing "code: ⟨junk⟩"
    // is a prompt the user cannot compare against anything.
    if body.code.len() != 6 || !body.code.chars().all(|c| c.is_ascii_digit()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    // The app NAME is displayed. Length-capped and stripped of control
    // characters so it cannot redraw the prompt around itself.
    let app: String = body
        .app
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    let app = if app.trim().is_empty() { "(unnamed)".to_string() } else { app.trim().to_string() };

    let info = peer::identify(peer_addr.port(), state.port);

    let id = format!("pair_{}_{}", epoch_secs(), crate::server::tokens::generate_token());
    let req = PairRequest {
        id: id.clone(),
        app,
        code: body.code.clone(),
        peer: info.clone(),
        created_at: epoch_secs(),
        status: PairStatus::Pending,
        token: None,
    };

    {
        let mut map = state.pairing.pending.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        state.pairing.expire(&mut map);

        // Rate limits. 429 rather than a dialog: the point of refusing is to
        // stop the user being asked, so the refusal must not ask them either.
        let now = epoch_secs();
        if let Some(pid) = info.as_ref().map(|p| p.pid) {
            let recent = map.values().any(|r| {
                r.peer.as_ref().map(|p| p.pid) == Some(pid)
                    && now.saturating_sub(r.created_at) < PER_PID_COOLDOWN_SECS
            });
            if recent {
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
        }
        if map.values().filter(|r| r.status == PairStatus::Pending).count() >= MAX_PENDING {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }

        map.insert(id.clone(), req.clone());
    }

    // Raise the prompt. The frontend owns the dialog; this only says there is
    // something to ask about.
    let _ = state.app_handle.emit(
        "pair-request",
        serde_json::json!({
            "id": req.id,
            "app": req.app,
            "code": req.code,
            "pid": req.peer.as_ref().map(|p| p.pid),
            "exe": req.peer.as_ref().and_then(|p| p.exe.clone()),
            "expiresIn": REQUEST_TTL_SECS,
        }),
    );

    Ok(Json(PairRequestResponse { request_id: id, expires_in: REQUEST_TTL_SECS }))
}

/// GET /api/pair/:id — the client waits here. Also needs no credential: the id
/// is a 32-hex nonce the requester was just handed, and the answer is useless
/// to anyone who did not ask the question.
pub async fn poll_pairing(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PairPollResponse>, StatusCode> {
    let mut map = state.pairing.pending.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.pairing.expire(&mut map);

    let req = map.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
    // The token is handed over ONCE. A poll that repeats after the client has
    // it is answered "approved" with nothing attached, so an id recovered from
    // a log later is not a second copy of the credential.
    let token = if req.status == PairStatus::Approved { req.token.take() } else { None };
    Ok(Json(PairPollResponse { status: req.status, token }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str, status: PairStatus, age: u64, pid: u32) -> PairRequest {
        PairRequest {
            id: id.into(),
            app: "JHEditor".into(),
            code: "123456".into(),
            peer: Some(PeerInfo { pid, exe: Some("C:/x/jheditor.exe".into()) }),
            created_at: epoch_secs().saturating_sub(age),
            status,
            token: None,
        }
    }

    #[test]
    fn an_unanswered_request_expires() {
        let st = PairingState::default();
        {
            let mut m = st.pending.lock().unwrap();
            m.insert("fresh".into(), req("fresh", PairStatus::Pending, 1, 10));
            m.insert("stale".into(), req("stale", PairStatus::Pending, REQUEST_TTL_SECS + 5, 11));
        }
        let pending = st.list_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "fresh");
    }

    // A stale dialog clicked twice must not mint a second token.
    #[test]
    fn only_a_pending_request_can_be_answered() {
        let st = PairingState::default();
        {
            let mut m = st.pending.lock().unwrap();
            m.insert("r".into(), req("r", PairStatus::Pending, 0, 10));
        }
        assert!(st.answer("r", true, Some("tok".into())));
        assert!(!st.answer("r", true, Some("tok2".into())), "a settled request is settled");
        let m = st.pending.lock().unwrap();
        assert_eq!(m["r"].token.as_deref(), Some("tok"));
        assert_eq!(m["r"].status, PairStatus::Approved);
    }

    #[test]
    fn answering_something_unknown_is_a_no_rather_than_a_panic() {
        let st = PairingState::default();
        assert!(!st.answer("nope", true, Some("tok".into())));
    }

    // An approved request stays in the map until its TTL so the client polling
    // for the answer actually receives it.
    #[test]
    fn an_approved_request_survives_long_enough_to_be_collected() {
        let st = PairingState::default();
        {
            let mut m = st.pending.lock().unwrap();
            m.insert("r".into(), req("r", PairStatus::Approved, 5, 10));
        }
        let mut m = st.pending.lock().unwrap();
        st.expire(&mut m);
        assert!(m.contains_key("r"));
    }

    #[test]
    fn a_denied_request_is_not_listed_as_pending() {
        let st = PairingState::default();
        {
            let mut m = st.pending.lock().unwrap();
            m.insert("r".into(), req("r", PairStatus::Denied, 1, 10));
        }
        assert!(st.list_pending().is_empty());
    }
}
