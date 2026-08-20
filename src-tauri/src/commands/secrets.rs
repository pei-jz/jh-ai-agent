// secrets — API keys in the OS credential store, not in ai_config.json.
//
// The keys used to sit in plaintext in `<app_config_dir>/ai_config.json`. That
// file is protected by nothing but the per-user ACL on AppData, which does not
// survive the ways a config file actually escapes: a Roaming profile syncing in
// a domain, a backup, a screen share, sending someone your settings to debug an
// issue. Those are the realistic exposures, and they are what this fixes.
//
// The backend is the OS credential store — Windows Credential Manager, macOS
// Keychain, Linux libsecret — reached through `keyring`. That is the same place
// VS Code's SecretStorage and Electron's safeStorage put secrets, and where
// Cline, Cursor and Zed keep their API keys.
//
// What this deliberately does NOT do is encrypt the file with a key the app
// holds. Anyone who can read the JSON can read the binary, so that would be
// obfuscation wearing the word "encrypted" — worse than plaintext, because it
// invites the belief that the problem is solved.
//
// ── When the store is unavailable ─────────────────────────────────────────
// A headless Linux box with no libsecret, or a locked keyring, cannot store
// anything. Two bad options and one acceptable one:
//   • refuse to save     → the app does not work at all on that machine;
//   • fall back silently → exactly the trap this module exists to avoid;
//   • fall back and SAY SO → what this does. `storage_backend()` reports it and
//     Settings shows it, so "my keys are in the keychain" is never assumed.

use keyring::Entry;

/// The credential-store service name. One namespace for the whole app.
const SERVICE: &str = "jh-ai-agent";

/// Config fields that hold a credential and therefore never belong in the JSON.
///
/// This list does NOT drive the code that moves them — Rust cannot index a
/// struct by string, so migrate_plaintext_keys / apply_stored_secrets /
/// extract_secrets each name their fields one by one. Its job is to be CHECKED
/// against the struct: `ai_config::secret_field_coverage` fails if AiConfig
/// grows a credential-shaped field that is not here, which is the failure that
/// actually happens — a new provider added, and its key left in plaintext
/// forever because three functions had to be edited and one was missed.
///
/// Hence dead code outside tests: being a list to compare against IS the use.
#[cfg_attr(not(test), allow(dead_code))]
pub const SECRET_FIELDS: [&str; 5] = [
    "openai_key",
    "anthropic_key",
    "gemini_key",
    "azure_key",
    "tavily_api_key",
];

/// The account name a per-connection key is stored under.
///
/// Namespaced so a connection called "openai_key" cannot collide with the
/// provider-level field of the same name.
pub fn instance_account(id: &str) -> String {
    format!("instance:{}", id)
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Read one secret. `Ok(None)` means "not stored", which is not an error.
pub fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write one secret. An empty value DELETES it — an empty key is not a key, and
/// leaving the old one behind would make "I cleared that field" a lie.
pub fn set(account: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return delete(account);
    }
    entry(account)?.set_password(value).map_err(|e| e.to_string())
}

/// Remove one secret. Absent is success: the caller wanted it gone.
pub fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Is the credential store usable on this machine?
///
/// Probed by round-tripping a throwaway value rather than by inspecting the
/// platform: what matters is whether a write will actually survive, and on
/// Linux that depends on a running secret service and an unlocked keyring, not
/// on which OS it is.
pub fn is_available() -> bool {
    // A UNIQUE probe account per call. A fixed one is shared state: two probes
    // overlapping meant the first one's delete removed the second one's entry,
    // and the second reported the store unavailable when it was fine.
    let probe = format!(
        "__probe_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    if set(&probe, "1").is_err() {
        return false;
    }
    let ok = matches!(get(&probe), Ok(Some(_)));
    let _ = delete(&probe);
    ok
}

/// What Settings should tell the user about where their keys live.
#[derive(serde::Serialize)]
pub struct StorageBackend {
    /// "keychain" | "file"
    pub kind: &'static str,
    /// The platform's own name for it, so the user knows where to look.
    pub name: &'static str,
    pub available: bool,
}

pub fn storage_backend() -> StorageBackend {
    let available = is_available();
    StorageBackend {
        kind: if available { "keychain" } else { "file" },
        name: if cfg!(target_os = "windows") {
            "Windows Credential Manager"
        } else if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else {
            "Secret Service (libsecret)"
        },
        available,
    }
}

/// Move a secret into the store, and confirm it arrived.
///
/// The read-back is the point: migration blanks the plaintext copy afterwards,
/// and a write that reported success but stored nothing would destroy the key.
/// Nothing is deleted from the JSON unless this returns `Ok(true)`.
pub fn migrate(account: &str, value: &str) -> Result<bool, String> {
    if value.is_empty() || value == "********" {
        return Ok(false);
    }
    set(account, value)?;
    Ok(matches!(get(account), Ok(Some(v)) if v == value))
}

#[tauri::command]
pub async fn get_secret_storage_info() -> Result<serde_json::Value, String> {
    let b = storage_backend();
    Ok(serde_json::json!({
        "kind": b.kind,
        "name": b.name,
        "available": b.available,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique account per test run, so a failed run cannot poison the next one
    /// and two runs in parallel cannot fight over the same entry.
    fn scratch(tag: &str) -> String {
        format!(
            "__test__{}_{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    }

    #[test]
    fn a_per_connection_account_is_namespaced() {
        // Without the prefix a connection whose id happened to be "openai_key"
        // would overwrite the provider-level key of that name.
        assert_eq!(instance_account("openai_key"), "instance:openai_key");
        assert_ne!(instance_account("openai_key"), "openai_key");
    }

    #[test]
    fn every_credential_field_is_listed() {
        for f in ["openai_key", "anthropic_key", "gemini_key", "azure_key", "tavily_api_key"] {
            assert!(SECRET_FIELDS.contains(&f), "{f} is missing from SECRET_FIELDS");
        }
    }

    // The remaining tests need a real credential store. On a CI box without one
    // they would fail for a reason that is not a defect, so they check first.
    #[test]
    fn a_secret_round_trips() {
        if !is_available() {
            eprintln!("no credential store available — skipping");
            return;
        }
        let acct = scratch("roundtrip");
        set(&acct, "sk-secret").unwrap();
        assert_eq!(get(&acct).unwrap(), Some("sk-secret".to_string()));
        delete(&acct).unwrap();
    }

    #[test]
    fn an_absent_secret_is_none_rather_than_an_error() {
        if !is_available() {
            return;
        }
        assert_eq!(get(&scratch("absent")).unwrap(), None);
    }

    // "I cleared that field" has to mean it.
    #[test]
    fn writing_an_empty_value_removes_the_secret() {
        if !is_available() {
            return;
        }
        let acct = scratch("clear");
        set(&acct, "sk-1").unwrap();
        set(&acct, "").unwrap();
        assert_eq!(get(&acct).unwrap(), None);
    }

    #[test]
    fn deleting_something_absent_is_success() {
        if !is_available() {
            return;
        }
        assert!(delete(&scratch("gone")).is_ok());
    }

    // Migration blanks the plaintext copy, so it must only report success when
    // the value can actually be read back.
    #[test]
    fn migrate_confirms_the_value_arrived() {
        if !is_available() {
            return;
        }
        let acct = scratch("migrate");
        assert!(migrate(&acct, "sk-real").unwrap());
        assert_eq!(get(&acct).unwrap(), Some("sk-real".to_string()));
        delete(&acct).unwrap();
    }

    // The masked placeholder is what the UI sends back for an untouched field;
    // storing it would replace the real key with five asterisks.
    #[test]
    fn migrate_refuses_the_mask_and_the_empty_string() {
        assert!(!migrate("unused", "********").unwrap());
        assert!(!migrate("unused", "").unwrap());
    }

    #[test]
    fn the_backend_names_where_to_look() {
        let b = storage_backend();
        assert!(!b.name.is_empty());
        assert!(b.kind == "keychain" || b.kind == "file");
        assert_eq!(b.available, b.kind == "keychain");
    }
}
