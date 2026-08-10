// updater — what the frontend needs to know about this build's update channel.
//
// Only one question: was a real signing key compiled in? The frontend uses it to
// decide whether checking for updates is even meaningful, so that a private or
// unsigned build says "auto-update is not configured" rather than reporting a
// permanent error the user cannot act on.
//
// The PUBLIC key is not a secret. It is embedded in the shipped binary by design, and
// its entire purpose is that anyone can verify our signatures with it. The PRIVATE key
// never appears here or anywhere else in this repository; it reaches a release build
// only through TAURI_SIGNING_PRIVATE_KEY. See docs/RELEASING.md.

/// The minisign public key this build verifies updates against, or "" when none.
///
/// Read from the COMPILED Tauri config rather than from tauri.conf.json on disk, so a
/// packaged build reports what it actually shipped with instead of whatever happens to
/// be in the working tree.
///
/// The config is walked as JSON rather than through the typed plugin structs: the
/// updater plugin owns its own config type and does not re-expose the key, and a JSON
/// lookup cannot break the build if that shape changes.
#[tauri::command]
pub fn updater_pubkey<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> String {
    serde_json::to_value(app.config())
        .ok()
        .and_then(|cfg| {
            cfg.get("plugins")
                .and_then(|p| p.get("updater"))
                .and_then(|u| u.get("pubkey"))
                .and_then(|k| k.as_str())
                .map(String::from)
        })
        // The placeholder counts as "not configured" — it is what ships in the repo
        // until someone generates a real key, and treating it as valid would have the
        // app claim it can verify updates when it cannot.
        .filter(|k| !k.trim().is_empty() && k != "REPLACE_WITH_YOUR_MINISIGN_PUBLIC_KEY")
        .unwrap_or_default()
}
