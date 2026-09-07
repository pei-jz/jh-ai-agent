// mailwatch — read a mailbox so the app does not need a helper process to.
//
// The first answer to "run when mail arrives" was a Python script registered in
// Windows Task Scheduler. It worked, and it was the wrong shape: an app that
// owns a scheduler was outsourcing the one part that makes it autonomous, and a
// second thing to install is a second thing to forget, break, and not notice
// breaking.
//
// Scope on purpose:
//   • READ ONLY. The mailbox is opened with `examine`, never `select`, so
//     watching your inbox does not mark anything read. A watcher that silently
//     changes what your mail client shows is a surprise nobody asked for.
//   • No deletion, no move, no reply. This exists to notice, not to act; acting
//     is the agent's job, through tools the user can see and approve.
//   • The password NEVER passes through the config file. It lives in the OS
//     credential store under `watcher:<id>` and this module reads it by id.

use serde::{Deserialize, Serialize};

/// One message, reduced to what a trigger and a prompt actually use.
#[derive(Debug, Serialize)]
pub struct MailMessage {
    /// RFC Message-ID. The identity a watcher dedupes on, so the same mail seen
    /// on the next poll does not start the task a second time.
    pub id: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub date: String,
    /// First text/plain part, trimmed. The agent reads the mail, not the MIME tree.
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct MailQuery {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    /// Credential-store id (`watcher:<id>`), never the password itself.
    pub secret_id: String,
    pub folder: Option<String>,
    pub from: Option<String>,
    pub subject: Option<String>,
    /// Unread only. On by default: a mailbox has years of history and a watcher
    /// asking for all of it would spend a minute and find nothing new.
    pub unseen_only: Option<bool>,
    /// Ceiling for one poll, so a flooded inbox cannot stall the timer.
    pub max_messages: Option<usize>,
}

/// The IMAP SEARCH for this query.
///
/// Split out because it is the part with rules worth pinning: quoting, and the
/// fact that an empty filter must not become `FROM ""` — which matches nothing
/// and would make a watcher look broken while behaving exactly as told.
pub fn build_search(q: &MailQuery) -> String {
    let mut parts: Vec<String> = Vec::new();
    if q.unseen_only.unwrap_or(true) {
        parts.push("UNSEEN".to_string());
    }
    if let Some(from) = q.from.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        parts.push(format!("FROM \"{}\"", from.replace('"', "")));
    }
    if let Some(sub) = q.subject.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        parts.push(format!("SUBJECT \"{}\"", sub.replace('"', "")));
    }
    if parts.is_empty() {
        // "everything" has to be said explicitly; an empty SEARCH is a protocol
        // error, not a wildcard.
        parts.push("ALL".to_string());
    }
    parts.join(" ")
}

/// Decode an RFC 2047 header into text.
///
/// Japanese senders and subjects arrive encoded far more often than not, and a
/// prompt built from `=?utf-8?B?…?=` is a prompt the model cannot use.
pub fn decode_header(raw: &str) -> String {
    match mailparse::parse_header(format!("X: {}", raw).as_bytes()) {
        Ok((h, _)) => h.get_value(),
        Err(_) => raw.to_string(),
    }
}

/// First text/plain part of a parsed message, capped.
pub fn text_body(parsed: &mailparse::ParsedMail, limit: usize) -> String {
    if parsed.subparts.is_empty() {
        let body = parsed.get_body().unwrap_or_default();
        return body.chars().take(limit).collect();
    }
    for part in &parsed.subparts {
        if part.ctype.mimetype == "text/plain" {
            let body = part.get_body().unwrap_or_default();
            return body.chars().take(limit).collect();
        }
        // Nested multipart (multipart/alternative inside multipart/mixed).
        let nested = text_body(part, limit);
        if !nested.is_empty() {
            return nested;
        }
    }
    String::new()
}

/// GET the matching messages. Read-only; nothing in the mailbox is modified.
#[tauri::command]
pub async fn imap_check(query: MailQuery) -> Result<serde_json::Value, String> {
    let password = crate::commands::secrets::get(&query.secret_id)?
        .ok_or_else(|| format!(
            "no password stored for this watcher. Enter it again in the watcher's settings \
             (it is kept in the OS credential store, not in a file)."
        ))?;

    // Blocking IMAP on a worker thread: the crate is synchronous and this runs
    // on a timer, so holding an async executor thread for a slow server would
    // stall unrelated work.
    let cap = query.max_messages.unwrap_or(25).clamp(1, 200);
    let folder = query.folder.clone().unwrap_or_else(|| "INBOX".to_string());
    let search = build_search(&query);
    let host = query.host.clone();
    let port = query.port.unwrap_or(993);
    let user = query.user.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS setup failed: {}", e))?;
        let client = imap::connect((host.as_str(), port), host.as_str(), &tls)
            .map_err(|e| format!("could not reach {}:{} — {}", host, port, e))?;
        let mut session = client
            .login(&user, &password)
            .map_err(|(e, _)| format!("login failed for {} — {}", user, e))?;

        // EXAMINE, not SELECT: read-only, so nothing is marked as read.
        session
            .examine(&folder)
            .map_err(|e| format!("could not open folder \"{}\" — {}", folder, e))?;

        let ids = session
            .search(&search)
            .map_err(|e| format!("search failed ({}) — {}", search, e))?;

        // Newest first, then capped: when a poll is truncated, the messages
        // worth having are the recent ones.
        let mut ids: Vec<u32> = ids.into_iter().collect();
        ids.sort_unstable_by(|a, b| b.cmp(a));
        let truncated = ids.len() > cap;
        ids.truncate(cap);

        let mut out: Vec<MailMessage> = Vec::new();
        for id in ids {
            let fetched = match session.fetch(id.to_string(), "RFC822") {
                Ok(f) => f,
                // One unreadable message is not a reason to lose the rest.
                Err(_) => continue,
            };
            for msg in fetched.iter() {
                let Some(raw) = msg.body() else { continue };
                let Ok(parsed) = mailparse::parse_mail(raw) else { continue };
                let h = |name: &str| {
                    parsed
                        .headers
                        .iter()
                        .find(|x| x.get_key().eq_ignore_ascii_case(name))
                        .map(|x| x.get_value())
                        .unwrap_or_default()
                };
                let message_id = h("Message-ID");
                out.push(MailMessage {
                    // Falling back to date+subject keeps dedupe working for the
                    // (rare, but real) sender that omits Message-ID.
                    id: if message_id.trim().is_empty() {
                        format!("{}|{}", h("Date"), h("Subject"))
                    } else {
                        message_id
                    },
                    from: h("From"),
                    to: h("To"),
                    subject: h("Subject"),
                    date: h("Date"),
                    body: text_body(&parsed, 2000),
                });
            }
        }

        let _ = session.logout();
        Ok(serde_json::json!({ "messages": out, "truncated": truncated }))
    })
    .await
    .map_err(|e| format!("mail check did not finish: {}", e))?
}

/// Store (or clear) a watcher's mailbox password.
///
/// Separate from saving the watcher itself so the password never travels with
/// the rest of the settings — the JSON is synced, backed up and screen-shared;
/// the credential store is not.
#[tauri::command]
pub async fn set_watcher_secret(id: String, password: String) -> Result<(), String> {
    crate::commands::secrets::set(&id, &password)
}

/// Read one back, for the backend calls that need the value itself.
///
/// Exposed to the frontend only because the HTTP watcher composes the request
/// there; the mailbox password never leaves Rust. Returns an empty string when
/// nothing is stored, so a missing credential produces an unauthenticated
/// request that fails with the server's own 401 rather than a puzzle here.
#[tauri::command]
pub async fn get_watcher_secret(id: String) -> Result<String, String> {
    Ok(crate::commands::secrets::get(&id)?.unwrap_or_default())
}

/// Is a password stored for this watcher? The value never comes back out to the
/// UI — only whether there is one, which is all a form needs to render.
#[tauri::command]
pub async fn has_watcher_secret(id: String) -> Result<bool, String> {
    Ok(crate::commands::secrets::get(&id)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q() -> MailQuery {
        MailQuery {
            host: "imap.example.com".into(),
            port: None,
            user: "me".into(),
            secret_id: "watcher:1".into(),
            folder: None,
            from: None,
            subject: None,
            unseen_only: None,
            max_messages: None,
        }
    }

    #[test]
    fn unread_only_is_the_default() {
        assert_eq!(build_search(&q()), "UNSEEN");
    }

    #[test]
    fn filters_are_added_as_given() {
        let mut m = q();
        m.from = Some("alerts@example.com".into());
        m.subject = Some("deploy failed".into());
        assert_eq!(
            build_search(&m),
            "UNSEEN FROM \"alerts@example.com\" SUBJECT \"deploy failed\""
        );
    }

    // A blank field means "no filter". Turning it into FROM "" would match
    // nothing at all, and the watcher would look broken while doing exactly
    // what it was told.
    #[test]
    fn a_blank_filter_is_not_a_filter() {
        let mut m = q();
        m.from = Some("   ".into());
        m.subject = Some("".into());
        assert_eq!(build_search(&m), "UNSEEN");
    }

    #[test]
    fn asking_for_everything_says_all_rather_than_nothing() {
        let mut m = q();
        m.unseen_only = Some(false);
        assert_eq!(build_search(&m), "ALL");
    }

    // A quote in a subject would end the quoted string early and corrupt the
    // rest of the search.
    #[test]
    fn quotes_cannot_break_out_of_the_search_string() {
        let mut m = q();
        m.subject = Some("say \"hello\"".into());
        assert_eq!(build_search(&m), "UNSEEN SUBJECT \"say hello\"");
    }

    #[test]
    fn encoded_headers_come_back_as_text() {
        // "テスト" in RFC 2047 Base64.
        assert_eq!(decode_header("=?utf-8?B?44OG44K544OI?="), "テスト");
        assert_eq!(decode_header("plain subject"), "plain subject");
    }
}
