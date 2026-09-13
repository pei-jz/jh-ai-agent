// tokens — who may reach what.
//
// There used to be ONE token. It sat in plaintext in ai_config.json, it was
// exported to a second plaintext file (%APPDATA%/JH/ai-connection.json) so
// sibling apps could find it, and holding it granted the whole API: start a
// task, run a shell command through it, read and rewrite the config. Every
// caller got the same key to the same door, and there was no way to revoke one
// caller without revoking all of them.
//
// ── The split ─────────────────────────────────────────────────────────────
// The realisation is that the callers are not alike. `POST /api/events` cannot
// start anything on its own: `post_event` hands the event to TriggerEngine,
// which runs something only if the user has already created and ENABLED a
// matching trigger. The authority lives in the trigger — configured by a person,
// in the app — not in whoever rings the bell. So ringing the bell does not need
// a key to the building.
//
// That matters because the bell-ringers are exactly the callers that CANNOT be
// asked to approve anything: a `.git/hooks/post-commit` running curl, a Task
// Scheduler script polling CI. There is nobody at the screen when they fire, so
// an approval prompt is a hang. They need a credential that outlives a restart —
// and a credential that outlives a restart must be worth little if it leaks.
//
// Hence two classes:
//
//   Scope::Full    — the whole API. The app's own frontend, and (once pairing
//                    lands) apps a person approved at the screen.
//   Scope::Events  — `POST /api/events` and nothing else. Persisted in the OS
//                    credential store, issued and revoked from the trigger
//                    panel, and pasted into the curl snippet that goes in a git
//                    hook.
//
// A leaked Events token lets an attacker fire triggers the user themselves
// created, with the prompts the user themselves wrote. That is not nothing —
// `{{payload.x}}` is interpolated into the prompt, so the sender influences what
// the agent reads — which is why it is still a credential and not an open door.
// But it is bounded in a way that "can run any shell command" is not.
//
// ── Paired tokens ─────────────────────────────────────────────────────────
// The third class, and the one the sibling apps use. Full scope, issued only
// through an approval prompt the user answered (server/pairing.rs), and NEVER
// WRITTEN DOWN — held in this process's memory and gone when the app closes.
//
// Not persisting is the point. The whole class of exposure that `secrets.rs`
// exists to fix — a config file leaking through a roaming profile, a backup, a
// screen share — needs a file to leak, and there isn't one. Closing the agent
// revokes every app at once, and an app uninstalled six months ago leaves no
// credential behind.
//
// "In memory" is not the same as "short-lived", though, on an agent that runs
// for a week. Two things bound each token:
//
//   • the PID it was issued to — when that process is gone, so is the token;
//   • an idle TTL — because a PID is reused, and because a client that stopped
//     talking has stopped needing to.
//
// Without those, twenty launches of an editor in a day would leave twenty live
// tokens in a process that never restarted.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::Rng;

use crate::commands::secrets;

/// What a credential may reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Scope {
    /// The whole API.
    Full,
    /// `POST /api/events` only.
    Events,
}

impl Scope {
    /// May a credential with this scope reach `method path`?
    ///
    /// Deny by default: a route added later is unreachable by a narrow
    /// credential until someone decides it should be. The opposite default
    /// grants access to routes nobody thought about.
    pub fn permits(&self, method: &str, path: &str) -> bool {
        match self {
            Scope::Full => true,
            Scope::Events => method.eq_ignore_ascii_case("POST") && path == "/api/events",
        }
    }
}

/// A credential that checked out, and what it was.
#[derive(Clone, Debug)]
pub struct Grant {
    pub scope: Scope,
    /// For the log line and the "connected apps" list. Never the token itself.
    pub label: String,
}

/// An event-only token, as stored.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct EventToken {
    /// Stable id — what the UI lists and revokes by.
    pub id: String,
    /// What the user called it: "git hook", "CI poller".
    pub label: String,
    /// RFC3339. Shown so a token nobody remembers issuing is visible as old.
    pub created_at: String,
    /// The secret. Serialized because the whole set round-trips through ONE
    /// credential-store entry — see `save`.
    pub token: String,
}

/// The public view of an event token. Same fields, minus the one that matters.
#[derive(Debug, serde::Serialize)]
pub struct EventTokenInfo {
    pub id: String,
    pub label: String,
    pub created_at: String,
}

/// The credential-store account the event tokens live under.
///
/// One entry holding a JSON array rather than one entry per token: the store is
/// a flat key-value map with no way to enumerate our own keys, so a per-token
/// account would need a separate index — and an index that drifts out of sync
/// with the entries is a token that can still authenticate but cannot be
/// revoked from the UI.
const EVENT_TOKENS_ACCOUNT: &str = "event_tokens";

/// Generate a random 32-character hex token.
pub fn generate_token() -> String {
    let bytes: Vec<u8> = (0..16).map(|_| rand::thread_rng().gen::<u8>()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

fn new_id() -> String {
    format!(
        "evt_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

/// Everything that can authenticate, in one place.
pub struct TokenRegistry {
    inner: Mutex<Inner>,
}

/// An app that paired this run.
#[derive(Clone, Debug)]
pub struct Paired {
    pub id: String,
    /// What the app called itself. A claim, shown next to `exe`, which is not.
    pub app: String,
    /// The executable the OS says opened the connection, when it could be read.
    pub exe: Option<String>,
    pub pid: u32,
    pub paired_at: String,
    /// Epoch seconds of the last request this token authenticated.
    last_used: u64,
    token: String,
}

/// The public view of a paired app — no token.
#[derive(Debug, serde::Serialize)]
pub struct PairedInfo {
    pub id: String,
    pub app: String,
    pub exe: Option<String>,
    pub pid: u32,
    pub paired_at: String,
    /// Seconds since this app last made a request.
    pub idle_seconds: u64,
}

/// How long a paired token survives without being used.
///
/// Eight hours is a working day: an editor left open over lunch keeps working,
/// and one left open over a weekend does not stay authenticated into Monday
/// without the user having been at the screen since.
pub const PAIRED_IDLE_TTL_SECS: u64 = 8 * 60 * 60;

struct Inner {
    /// The app's own frontend, handed over Tauri IPC by `get_api_token`.
    ///
    /// Generated per run and never written to disk: the frontend gets it over
    /// Tauri IPC, which no other process can call.
    full: String,
    events: Vec<EventToken>,
    paired: Vec<Paired>,
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl TokenRegistry {
    /// Build with the full-scope token, loading any stored event tokens.
    ///
    /// A credential store that cannot be read is not a failure to start: the
    /// app works, event tokens simply do not authenticate until it can. Failing
    /// to boot because a Linux keyring is locked would be worse than the thing
    /// being protected.
    pub fn new(full: String) -> Self {
        let events = match secrets::get(EVENT_TOKENS_ACCOUNT) {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
            _ => Vec::new(),
        };
        Self { inner: Mutex::new(Inner { full, events, paired: Vec::new() }) }
    }

    /// Does `presented` authenticate, and to what?
    ///
    /// Every candidate is compared in constant time AND every candidate is
    /// compared — no early return on the first hit. Returning as soon as
    /// something matches would make "the first token in the list" measurably
    /// faster to guess than the last.
    pub fn verify(&self, presented: &str) -> Option<Grant> {
        // Nothing is not a credential.
        //
        // `constant_time_eq(b"", b"")` is true, so an empty STORED token would be
        // authenticated by `Authorization: Bearer ` with nothing after it. No
        // code path produces an empty token today — which is exactly why this
        // has to be stated here rather than assumed at every site that could
        // start producing one. Returning early leaks nothing: the sender
        // already knows the length of what they sent.
        if presented.is_empty() {
            return None;
        }

        let mut inner = self.inner.lock().ok()?;

        // Expire before comparing, so a token that is past its idle window
        // cannot authenticate the very request that would have refreshed it.
        let now = epoch_secs();
        inner.paired.retain(|p| now.saturating_sub(p.last_used) < PAIRED_IDLE_TTL_SECS);

        let mut found: Option<Grant> = None;
        let mut refresh: Option<usize> = None;

        if !inner.full.is_empty()
            && constant_time_eq(presented.as_bytes(), inner.full.as_bytes())
        {
            found = Some(Grant { scope: Scope::Full, label: "app".to_string() });
        }
        for t in &inner.events {
            if !t.token.is_empty()
                && constant_time_eq(presented.as_bytes(), t.token.as_bytes())
            {
                found = Some(Grant { scope: Scope::Events, label: t.label.clone() });
            }
        }
        for (i, p) in inner.paired.iter().enumerate() {
            if !p.token.is_empty()
                && constant_time_eq(presented.as_bytes(), p.token.as_bytes())
            {
                found = Some(Grant { scope: Scope::Full, label: p.app.clone() });
                refresh = Some(i);
            }
        }

        // The idle clock is "time since last USE", so using it is what resets it.
        if let Some(i) = refresh {
            inner.paired[i].last_used = now;
        }
        found
    }

    /// Record an app the user approved. Returns the token to hand back.
    pub fn add_paired(&self, app: &str, exe: Option<String>, pid: u32) -> Result<String, String> {
        let token = generate_token();
        let mut inner = self.inner.lock().map_err(|_| "token registry poisoned".to_string())?;
        // One live token per process. Re-pairing after the agent restarted is
        // the common case, and keeping the previous entry would show the same
        // app twice in the list with no way to tell which one is current.
        inner.paired.retain(|p| p.pid != pid);
        inner.paired.push(Paired {
            id: format!("pair_{}", epoch_secs()),
            app: app.to_string(),
            exe,
            pid,
            paired_at: now_rfc3339(),
            last_used: epoch_secs(),
            token: token.clone(),
        });
        Ok(token)
    }

    /// Drop a paired app's token. Takes effect on its very next request.
    pub fn revoke_paired(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "token registry poisoned".to_string())?;
        inner.paired.retain(|p| p.id != id);
        Ok(())
    }

    /// Forget tokens whose process is gone, and tokens nobody has used.
    ///
    /// `is_alive` is injected rather than called directly so the rule can be
    /// tested without spawning processes — and so the caller decides how
    /// expensive liveness checking is allowed to be.
    pub fn sweep_paired(&self, is_alive: impl Fn(u32) -> bool) {
        if let Ok(mut inner) = self.inner.lock() {
            let now = epoch_secs();
            inner.paired.retain(|p| {
                now.saturating_sub(p.last_used) < PAIRED_IDLE_TTL_SECS && is_alive(p.pid)
            });
        }
    }

    /// What the "connected apps" list shows. No tokens, by construction.
    pub fn list_paired(&self) -> Vec<PairedInfo> {
        let now = epoch_secs();
        self.inner
            .lock()
            .map(|i| {
                i.paired
                    .iter()
                    .map(|p| PairedInfo {
                        id: p.id.clone(),
                        app: p.app.clone(),
                        exe: p.exe.clone(),
                        pid: p.pid,
                        paired_at: p.paired_at.clone(),
                        idle_seconds: now.saturating_sub(p.last_used),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The full-scope token, for the places that still hand it out (the Tauri
    /// IPC command, and the WebSocket URLs the API returns).
    pub fn full_token(&self) -> String {
        self.inner.lock().map(|i| i.full.clone()).unwrap_or_default()
    }

    /// Mint an event-only token. Returns the SECRET — the only time it is
    /// readable, because the caller has to be able to paste it into a hook.
    pub fn issue_event_token(&self, label: &str) -> Result<(String, EventTokenInfo), String> {
        let token = generate_token();
        let record = EventToken {
            id: new_id(),
            label: if label.trim().is_empty() { "event token".to_string() } else { label.trim().to_string() },
            created_at: now_rfc3339(),
            token: token.clone(),
        };
        let info = EventTokenInfo {
            id: record.id.clone(),
            label: record.label.clone(),
            created_at: record.created_at.clone(),
        };

        let mut inner = self.inner.lock().map_err(|_| "token registry poisoned".to_string())?;
        inner.events.push(record);
        // Persist BEFORE reporting success. A token the caller pastes into a git
        // hook and which does not survive the next restart is worse than one
        // that was never issued: the hook fails silently, months later.
        save(&inner.events)?;
        Ok((token, info))
    }

    /// Forget an event token. Absent is success — the caller wanted it gone.
    pub fn revoke_event_token(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "token registry poisoned".to_string())?;
        inner.events.retain(|t| t.id != id);
        save(&inner.events)
    }

    /// What the settings UI lists. Secrets are not included, by construction.
    pub fn list_event_tokens(&self) -> Vec<EventTokenInfo> {
        self.inner
            .lock()
            .map(|i| {
                i.events
                    .iter()
                    .map(|t| EventTokenInfo {
                        id: t.id.clone(),
                        label: t.label.clone(),
                        created_at: t.created_at.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Write the whole set back to the credential store.
fn save(events: &[EventToken]) -> Result<(), String> {
    // An empty set DELETES the entry rather than storing "[]": revoking the last
    // token should leave nothing behind.
    if events.is_empty() {
        return secrets::delete(EVENT_TOKENS_ACCOUNT);
    }
    let json = serde_json::to_string(events).map_err(|e| e.to_string())?;
    secrets::set(EVENT_TOKENS_ACCOUNT, &json)
}

/// Compare two byte strings without leaking WHERE they differ.
///
/// Lifted from auth.rs, which documents the reasoning: `a == b` returns as soon
/// as a byte mismatches, so the time it takes reveals how many leading bytes
/// were right, and a guess can be built one byte at a time. Length is folded
/// into the result rather than short-circuiting, so a wrong-length token takes
/// the same path as a wrong-value one.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().min(b.len());
    for i in 0..n {
        diff |= a[i] ^ b[i];
    }
    diff == 0 && a.len() == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The scope table is the whole security claim of the event token, so it is
    // pinned route by route rather than "it works".
    #[test]
    fn events_scope_reaches_exactly_one_route() {
        let s = Scope::Events;
        assert!(s.permits("POST", "/api/events"));

        // The routes that can start work, read the log, or rewrite the config.
        for (m, p) in [
            ("POST", "/api/tasks"),
            ("GET", "/api/tasks"),
            ("GET", "/api/tasks/abc"),
            ("DELETE", "/api/tasks/abc"),
            ("GET", "/api/tasks/abc/logs"),
            ("POST", "/api/tasks/abc/steering"),
            ("POST", "/api/tasks/abc/continue"),
            ("GET", "/api/config"),
            ("PUT", "/api/config"),
            ("POST", "/api/config/test"),
            ("GET", "/api/stats"),
            ("GET", "/api/models"),
        ] {
            assert!(!s.permits(m, p), "Events must not reach {m} {p}");
        }
    }

    #[test]
    fn events_scope_is_method_specific() {
        // Reading is not what the bell is for, and /api/events has no GET
        // anyway — but the check must not be path-only.
        assert!(!Scope::Events.permits("GET", "/api/events"));
        assert!(!Scope::Events.permits("DELETE", "/api/events"));
        assert!(Scope::Events.permits("post", "/api/events"), "method match is case-insensitive");
    }

    // Deny-by-default: a route added later must not become reachable by a narrow
    // credential just because nobody revisited this file.
    #[test]
    fn an_unknown_route_is_closed_to_the_narrow_scope() {
        assert!(!Scope::Events.permits("POST", "/api/some-route-added-in-2027"));
        assert!(!Scope::Events.permits("POST", "/api/events/replay"));
        assert!(!Scope::Events.permits("POST", "/api/events/"));
    }

    #[test]
    fn full_scope_reaches_everything() {
        for (m, p) in [("POST", "/api/tasks"), ("PUT", "/api/config"), ("POST", "/api/events")] {
            assert!(Scope::Full.permits(m, p));
        }
    }

    #[test]
    fn the_app_token_verifies_as_full() {
        let reg = TokenRegistry::new("abc123".into());
        let g = reg.verify("abc123").expect("the app token should verify");
        assert_eq!(g.scope, Scope::Full);
    }

    #[test]
    fn an_unknown_token_verifies_as_nothing() {
        let reg = TokenRegistry::new("abc123".into());
        assert!(reg.verify("abc124").is_none());
        assert!(reg.verify("").is_none());
        assert!(reg.verify("abc1234").is_none(), "a correct PREFIX is not a match");
        assert!(reg.verify("abc12").is_none());
    }

    // An empty full token would otherwise be matched by an empty Authorization
    // header value — "Bearer " with nothing after it.
    #[test]
    fn an_empty_presented_token_never_matches_an_empty_stored_one() {
        let reg = TokenRegistry::new(String::new());
        assert!(reg.verify("").is_none(), "empty must not authenticate");
    }

    #[test]
    fn constant_time_eq_matches_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"", b"a"));
    }

    #[test]
    fn constant_time_eq_rejects_a_correct_prefix() {
        // The shape a byte-at-a-time guess relies on.
        let token = "0123456789abcdef0123456789abcdef";
        assert!(!constant_time_eq(b"0", token.as_bytes()));
        assert!(!constant_time_eq(b"0123456789abcdef", token.as_bytes()));
        assert!(constant_time_eq(token.as_bytes(), token.as_bytes()));
    }

    #[test]
    fn a_generated_token_is_32_hex_chars_and_unique() {
        let a = generate_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, generate_token());
    }

    // The listing is what the UI renders. If a secret can reach it, it reaches
    // a screenshot.
    #[test]
    fn the_listing_carries_no_secret() {
        let reg = TokenRegistry::new("app".into());
        let mut inner = reg.inner.lock().unwrap();
        inner.events.push(EventToken {
            id: "evt_1".into(),
            label: "git hook".into(),
            created_at: "2026-09-12T00:00:00+09:00".into(),
            token: "SECRETSECRETSECRET".into(),
        });
        drop(inner);

        let listed = reg.list_event_tokens();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "git hook");
        let json = serde_json::to_string(&listed).unwrap();
        assert!(!json.contains("SECRET"), "a listing must never carry the token");
    }

    #[test]
    fn an_event_token_verifies_as_events_only() {
        let reg = TokenRegistry::new("app".into());
        {
            let mut inner = reg.inner.lock().unwrap();
            inner.events.push(EventToken {
                id: "evt_1".into(),
                label: "git hook".into(),
                created_at: now_rfc3339(),
                token: "eventtoken".into(),
            });
        }
        let g = reg.verify("eventtoken").expect("the event token should verify");
        assert_eq!(g.scope, Scope::Events);
        assert_eq!(g.label, "git hook");
        assert!(!g.scope.permits("POST", "/api/tasks"));
    }

    // Revoking is what makes a persisted credential acceptable at all.
    // ── Paired tokens ────────────────────────────────────────────────────

    #[test]
    fn a_paired_app_gets_full_scope_under_its_own_name() {
        let reg = TokenRegistry::new("app".into());
        let tok = reg.add_paired("JHEditor", Some("C:/x/jheditor.exe".into()), 4242).unwrap();
        let g = reg.verify(&tok).expect("a paired token should verify");
        assert_eq!(g.scope, Scope::Full);
        assert_eq!(g.label, "JHEditor", "the log and the list say WHICH app");
    }

    // Re-pairing after the agent restarted is the common case. Two rows for one
    // process would show the same app twice with no way to tell which is live.
    #[test]
    fn pairing_again_from_the_same_process_replaces_the_old_token() {
        let reg = TokenRegistry::new("app".into());
        let first = reg.add_paired("JHEditor", None, 4242).unwrap();
        let second = reg.add_paired("JHEditor", None, 4242).unwrap();
        assert!(reg.verify(&first).is_none(), "the superseded token must stop working");
        assert!(reg.verify(&second).is_some());
        assert_eq!(reg.list_paired().len(), 1);
    }

    #[test]
    fn a_revoked_app_stops_working_on_its_next_request() {
        let reg = TokenRegistry::new("app".into());
        let tok = reg.add_paired("JHEditor", None, 4242).unwrap();
        let id = reg.list_paired()[0].id.clone();
        reg.revoke_paired(&id).unwrap();
        assert!(reg.verify(&tok).is_none());
        assert!(reg.list_paired().is_empty());
    }

    // "In memory" is not "short-lived" on an agent that runs for a week: twenty
    // launches of an editor would otherwise leave twenty live tokens.
    #[test]
    fn an_idle_token_expires_and_cannot_authenticate_the_request_that_would_refresh_it() {
        let reg = TokenRegistry::new("app".into());
        let tok = reg.add_paired("JHEditor", None, 4242).unwrap();
        {
            let mut inner = reg.inner.lock().unwrap();
            inner.paired[0].last_used = epoch_secs() - PAIRED_IDLE_TTL_SECS - 1;
        }
        assert!(reg.verify(&tok).is_none(), "expiry runs BEFORE the comparison");
        assert!(reg.list_paired().is_empty(), "and the row is gone");
    }

    #[test]
    fn using_a_token_resets_its_idle_clock() {
        let reg = TokenRegistry::new("app".into());
        let tok = reg.add_paired("JHEditor", None, 4242).unwrap();
        {
            let mut inner = reg.inner.lock().unwrap();
            inner.paired[0].last_used = epoch_secs() - PAIRED_IDLE_TTL_SECS + 60;
        }
        assert!(reg.verify(&tok).is_some());
        assert_eq!(reg.list_paired()[0].idle_seconds, 0, "the use reset the clock");
    }

    #[test]
    fn a_sweep_drops_tokens_whose_process_is_gone() {
        let reg = TokenRegistry::new("app".into());
        let live = reg.add_paired("JHEditor", None, 1111).unwrap();
        let dead = reg.add_paired("JHER", None, 2222).unwrap();
        reg.sweep_paired(|pid| pid == 1111);
        assert!(reg.verify(&live).is_some());
        assert!(reg.verify(&dead).is_none());
    }

    #[test]
    fn the_paired_listing_carries_no_token() {
        let reg = TokenRegistry::new("app".into());
        let tok = reg.add_paired("JHEditor", Some("C:/x/jheditor.exe".into()), 4242).unwrap();
        let json = serde_json::to_string(&reg.list_paired()).unwrap();
        assert!(json.contains("jheditor.exe"));
        assert!(!json.contains(&tok), "a listing must never carry the token");
    }

    #[test]
    fn a_revoked_token_stops_verifying() {
        let reg = TokenRegistry::new("app".into());
        {
            let mut inner = reg.inner.lock().unwrap();
            inner.events.push(EventToken {
                id: "evt_1".into(),
                label: "git hook".into(),
                created_at: now_rfc3339(),
                token: "eventtoken".into(),
            });
        }
        assert!(reg.verify("eventtoken").is_some());
        // Ignore the store result: this machine's keyring may be unavailable,
        // and the in-memory set is what `verify` reads.
        let _ = reg.revoke_event_token("evt_1");
        assert!(reg.verify("eventtoken").is_none());
        assert!(reg.list_event_tokens().is_empty());
    }
}
