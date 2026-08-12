// license — verify a licence key's signature.
//
// This is the only part of licensing that has to be cryptography, and the only part
// that must not live in JavaScript: the frontend ships as readable source, so a check
// written there is self-evidently editable. (Being honest: this repository ships under
// MIT OR Apache-2.0, so the whole gate is removable by recompiling — see
// docs/design/licensing.md §2. Doing the verification properly here is still worth it,
// because it makes an *accidentally* accepted forged key impossible, which is the
// realistic failure.)
//
// Key format:  JHAI1.<base64url(payload)>.<base64url(ed25519 signature)>
//
// The signature covers the base64url payload STRING, not the decoded JSON. Signing the
// encoded form removes JSON canonicalisation from the trust path entirely — no key
// ordering or whitespace difference can make a genuine key fail to verify.
//
// Verification is fully OFFLINE: no request, no telemetry, works on an air-gapped
// machine. See licensing.md §5 for why that constraint is not negotiable.

use base64::Engine;
use ed25519_dalek::Signature;

/// The Ed25519 public key licences are verified against, hex-encoded (32 bytes).
///
/// A public key is not a secret — embedding it is the point. The SIGNING key lives
/// with whoever issues licences and never enters this repository, exactly like the
/// updater's minisign key (docs/RELEASING.md).
const LICENSE_PUBKEY_HEX: &str = "REPLACE_WITH_LICENSE_ED25519_PUBLIC_KEY_HEX";

#[derive(serde::Serialize)]
pub struct LicenseCheck {
    /// Did the signature verify against the embedded key?
    pub verified: bool,
    /// The decoded payload as JSON, or null. Present even when unverified so the UI
    /// can say "this key is for Pro but does not verify" rather than just "bad key".
    pub payload: Option<serde_json::Value>,
    /// Machine-readable reason when `verified` is false.
    pub reason: String,
}

impl LicenseCheck {
    fn fail(reason: &str, payload: Option<serde_json::Value>) -> Self {
        Self { verified: false, payload, reason: reason.to_string() }
    }
}

fn b64() -> base64::engine::GeneralPurpose {
    // URL-safe, no padding: licence keys get pasted into single-line fields and
    // emailed, where `+`, `/` and `=` reliably get mangled.
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::general_purpose::NO_PAD,
    )
}

/// Decode the embedded public key, or None when it is still the placeholder.
fn verifying_key() -> Option<ed25519_dalek::VerifyingKey> {
    let hex = LICENSE_PUBKEY_HEX.trim();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = [0u8; 32];
    for i in 0..32 {
        bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    ed25519_dalek::VerifyingKey::from_bytes(&bytes).ok()
}

/// Verify a licence key. Never panics and never returns Err — a malformed key is a
/// normal outcome (someone pasted the wrong thing), not an error condition.
#[tauri::command]
pub fn verify_license(key: String) -> LicenseCheck {
    let key = key.trim();
    if key.is_empty() {
        return LicenseCheck::fail("empty", None);
    }

    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() != 3 || parts[0] != "JHAI1" {
        return LicenseCheck::fail("malformed", None);
    }

    let engine = b64();
    let payload_bytes = match engine.decode(parts[1]) {
        Ok(b) => b,
        Err(_) => return LicenseCheck::fail("malformed", None),
    };
    // Decoded up front so an unverified key can still be *described* to the user.
    let payload: Option<serde_json::Value> = serde_json::from_slice(&payload_bytes).ok();
    if payload.is_none() {
        return LicenseCheck::fail("malformed", None);
    }

    let sig_bytes = match engine.decode(parts[2]) {
        Ok(b) => b,
        Err(_) => return LicenseCheck::fail("malformed", payload),
    };
    let sig_array: [u8; 64] = match sig_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return LicenseCheck::fail("malformed", payload),
    };

    let Some(vk) = verifying_key() else {
        // No issuing key was compiled in. Say so distinctly: reporting "invalid"
        // would blame the customer's key for our own unconfigured build.
        return LicenseCheck::fail("unconfigured", payload);
    };

    // The signed message is the base64url payload text exactly as it appears in the key.
    match vk.verify_strict(parts[1].as_bytes(), &Signature::from_bytes(&sig_array)) {
        Ok(()) => LicenseCheck { verified: true, payload, reason: String::new() },
        Err(_) => LicenseCheck::fail("bad_signature", payload),
    }
}

/// Is an issuing key compiled into this build? Lets Settings distinguish
/// "licensing is not set up" from "your key is wrong".
#[tauri::command]
pub fn license_configured() -> bool {
    verifying_key().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Mint a key the way the issuer would, so the format is tested end to end.
    fn mint(sk: &SigningKey, payload: &str) -> String {
        let engine = b64();
        let p = engine.encode(payload.as_bytes());
        let sig = sk.sign(p.as_bytes());
        format!("JHAI1.{}.{}", p, engine.encode(sig.to_bytes()))
    }

    fn sample_sk() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn placeholder_key_is_not_a_key() {
        // The repo ships without an issuing key; it must not read as configured.
        assert!(!LICENSE_PUBKEY_HEX.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(verifying_key().is_none());
    }

    #[test]
    fn rejects_garbage() {
        for bad in ["", "   ", "hello", "JHAI1.only-two", "JHAI2.a.b", "JHAI1.!!!.!!!"] {
            let r = verify_license(bad.to_string());
            assert!(!r.verified, "accepted {bad:?}");
        }
    }

    #[test]
    fn reports_unconfigured_rather_than_invalid() {
        // A well-formed key on a build with no issuing key must not be blamed on the
        // customer. This is the case the placeholder build actually hits.
        let key = mint(&sample_sk(), r#"{"edition":"pro"}"#);
        let r = verify_license(key);
        assert!(!r.verified);
        assert_eq!(r.reason, "unconfigured");
        // …and the payload is still readable, so the UI can name the edition.
        assert_eq!(r.payload.unwrap()["edition"], "pro");
    }

    #[test]
    fn signature_covers_the_payload() {
        // Swap the payload for another validly-encoded one, keeping the signature:
        // the classic forgery attempt. It must not verify even in principle.
        let sk = sample_sk();
        let real = mint(&sk, r#"{"edition":"community"}"#);
        let engine = b64();
        let forged_payload = engine.encode(r#"{"edition":"enterprise"}"#.as_bytes());
        let sig = real.split('.').nth(2).unwrap();
        let forged = format!("JHAI1.{forged_payload}.{sig}");

        let vk = sk.verifying_key();
        assert!(vk
            .verify_strict(
                forged_payload.as_bytes(),
                &Signature::from_bytes(
                    &engine.decode(sig).unwrap().try_into().unwrap()
                ),
            )
            .is_err());
        assert!(!verify_license(forged).verified);
    }

    #[test]
    fn genuine_key_verifies_against_its_own_issuer() {
        // The embedded key is a placeholder here, so exercise the crypto path with a
        // locally generated pair — this is what a configured build does.
        let sk = sample_sk();
        let vk = sk.verifying_key();
        let key = mint(&sk, r#"{"id":"L-1","edition":"pro","expires":"2027-01-01"}"#);
        let parts: Vec<&str> = key.split('.').collect();
        let sig: [u8; 64] = b64().decode(parts[2]).unwrap().try_into().unwrap();

        assert!(vk
            .verify_strict(parts[1].as_bytes(), &Signature::from_bytes(&sig))
            .is_ok());
    }

    #[test]
    fn keys_survive_being_emailed() {
        // URL-safe base64 without padding: no '+', '/' or '=' to be mangled by a
        // mail client or a form field.
        let key = mint(&sample_sk(), r#"{"licensee":"株式会社テスト","edition":"pro"}"#);
        assert!(!key.contains('+') && !key.contains('/') && !key.contains('='));
        // Non-ASCII licensee names round-trip.
        let r = verify_license(key);
        assert_eq!(r.payload.unwrap()["licensee"], "株式会社テスト");
    }
}
