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
pub async fn auth_middleware(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
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
            if token == expected_token {
                Ok(next.run(request).await)
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Wrapper type to store the auth token in request extensions.
#[derive(Clone, Debug)]
pub struct AuthToken(pub String);

#[cfg(test)]
mod tests {
    use super::*;

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
