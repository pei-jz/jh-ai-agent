// Authentication module for the axum server.
// Generates a random session token at startup and validates it on incoming requests.

use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use rand::Rng;

/// Generate a random 32-character hex token for session authentication.
pub fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen::<u8>()).collect();
    hex_encode(&bytes)
}

/// Simple hex encoding without pulling in the `hex` crate.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Axum middleware layer that validates the `Authorization: Bearer <token>` header.
/// Skips authentication for `GET /api/health` so monitoring tools can reach it.
/// Hosts a loopback request may legitimately name.
///
/// A browser resolving `evil.example` to 127.0.0.1 (DNS rebinding) reaches this
/// server with `Host: evil.example`, and same-origin policy then treats the
/// response as belonging to that site. The token is what actually protects the
/// authenticated routes, but the token travels in a WebSocket URL's query string
/// and therefore into logs — so the Host check is the layer that does not depend
/// on the token having stayed secret.
///
/// Report_20260829.md B6.
fn host_is_loopback(host: &str) -> bool {
    // Strip the port; IPv6 literals are bracketed.
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(name, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || name.starts_with("127.")
}

pub async fn auth_middleware(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    // The Host header must name loopback. This runs BEFORE the health exemption
    // so that a rebound page cannot even use /api/health to confirm the app is
    // running on this machine.
    let host_ok = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(host_is_loopback)
        // HTTP/2 sends :authority instead of Host; axum surfaces it on the URI.
        .or_else(|| request.uri().host().map(host_is_loopback))
        .unwrap_or(false);
    if !host_ok {
        return Err(StatusCode::FORBIDDEN);
    }

    // Skip auth for the health endpoint
    let path = request.uri().path();
    if path == "/api/health" && request.method() == axum::http::Method::GET {
        return Ok(next.run(request).await);
    }

    // WebSocket routes use query-param auth, handled in ws.rs
    if path.starts_with("/ws/") {
        return Ok(next.run(request).await);
    }

    // Extract the expected token from the request extensions (set by the router layer)
    let expected_token = request
        .extensions()
        .get::<AuthToken>()
        .map(|t| t.0.clone());

    let expected_token = match expected_token {
        Some(t) => t,
        None => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };

    // Validate Authorization header
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(value) if value.starts_with("Bearer ") => {
            let token = &value[7..];
            if constant_time_eq(token.as_bytes(), expected_token.as_bytes()) {
                Ok(next.run(request).await)
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Compare two byte strings without leaking WHERE they differ.
///
/// `a == b` on a slice returns as soon as a byte mismatches, so the time it
/// takes reveals how many leading bytes were right — a guess can then be built
/// one byte at a time. The server is on loopback, which makes this hard to
/// exploit rather than impossible: a page in the user's browser can time
/// requests to 127.0.0.1, and the token is a 32-character hex string.
///
/// Length is compared first and then folded into the result, so a wrong-length
/// token takes the same path as a wrong-value one.
/// Report_20260829.md B5.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    // Never short-circuit on length either: return AFTER accumulating.
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().min(b.len());
    for i in 0..n {
        diff |= a[i] ^ b[i];
    }
    // A length mismatch already set a bit above; the loop cannot clear it.
    diff == 0 && a.len() == b.len()
}

/// Wrapper type to store the auth token in request extensions.
#[derive(Clone, Debug)]
pub struct AuthToken(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    // The property that matters is not "it says yes to the right token" — `==`
    // does that too — but that it says NO the same way every time.
    #[test]
    fn host_must_be_loopback() {
        for good in ["localhost", "localhost:14300", "127.0.0.1", "127.0.0.1:14300",
                     "127.1.2.3", "[::1]", "[::1]:14300"] {
            assert!(host_is_loopback(good), "{good} should be accepted");
        }
        // The DNS-rebinding shape: a name that RESOLVES to 127.0.0.1 but is not
        // loopback, so the browser treats the response as that site's.
        for bad in ["evil.example", "evil.example:14300", "jhai.attacker.test",
                    "192.168.1.5", "10.0.0.1", ""] {
            assert!(!host_is_loopback(bad), "{bad} should be rejected");
        }
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
    fn token_is_32_hex_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 32, "token should be 16 bytes => 32 hex chars");
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn tokens_are_unique() {
        // Extremely unlikely to collide for a 128-bit random token.
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
    }

    #[test]
    fn hex_encode_pads_each_byte() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xff]), "000fff");
    }
}
