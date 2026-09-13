// auth — the gate in front of the axum server.
//
// Two checks, in this order: the request must NAME loopback (Host), and it
// must CARRY a credential that reaches the route it asked for. The second is
// server/tokens.rs's job — this module decides when to ask and what a refusal
// means; minting, storing and scoping live there.

use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};

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

/// The Host check on its own, for the routes the middleware does not cover.
///
/// `auth_middleware` is layered only on `/api`, so the two WebSocket routes —
/// `/ws/tasks/:id` and `/mcp/ws` — validated the token and nothing else. That
/// is backwards relative to why this check exists: the reasoning above says the
/// Host check is the layer that does not depend on the token having stayed
/// secret, precisely BECAUSE the token travels in a WebSocket URL's query
/// string and therefore into logs. The route that leaks the token was the one
/// route with no second layer.
pub fn request_host_is_loopback<B>(request: &axum::http::Request<B>) -> bool {
    request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(host_is_loopback)
        // HTTP/2 sends :authority instead of Host; axum surfaces it on the URI.
        .or_else(|| request.uri().host().map(host_is_loopback))
        .unwrap_or(false)
}

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

    // Every credential that can authenticate, and what each one may reach.
    // Set by the router layer; see server/tokens.rs for the two classes.
    let registry = match request.extensions().get::<Registry>() {
        Some(r) => r.0.clone(),
        None => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };

    // Validate Authorization header
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let presented = match auth_header {
        Some(value) if value.starts_with("Bearer ") => &value[7..],
        _ => return Err(StatusCode::UNAUTHORIZED),
    };

    let grant = match registry.verify(presented) {
        Some(g) => g,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    // A real token for the wrong route is 403, not 401.
    //
    // 401 means "authenticate"; a git hook holding an event-only token would
    // read that as "my token is wrong" and the user would reissue it, again and
    // again, for a request that will never be allowed. 403 says the credential
    // is fine and the route is not its business.
    if !grant.scope.permits(request.method().as_str(), request.uri().path()) {
        return Err(StatusCode::FORBIDDEN);
    }

    Ok(next.run(request).await)
}

/// Host-only gate, for routes that have no credential to check.
///
/// The pairing routes are reachable before an app has a token, so
/// `auth_middleware` cannot cover them — but the DNS-rebinding defence must
/// still apply. Without it a page on the open internet, resolved to 127.0.0.1,
/// could POST a pairing request and put a dialog in front of the user.
pub async fn loopback_only(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if !request_host_is_loopback(&request) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}

/// The credential registry, carried in request extensions by the router layer.
#[derive(Clone)]
pub struct Registry(pub std::sync::Arc<crate::server::tokens::TokenRegistry>);

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

    // The WebSocket routes are not behind auth_middleware, so they call
    // `request_host_is_loopback` directly. This pins the helper the same way
    // the middleware's own path is pinned.
    #[test]
    fn the_standalone_host_check_reads_the_header_then_the_uri() {
        use axum::http::Request;

        let with_host = |h: &str| {
            Request::builder().uri("/ws/tasks/1?token=x")
                .header(header::HOST, h).body(()).unwrap()
        };
        assert!(request_host_is_loopback(&with_host("127.0.0.1:1425")));
        assert!(request_host_is_loopback(&with_host("localhost:1425")));
        assert!(!request_host_is_loopback(&with_host("evil.example")));
        assert!(!request_host_is_loopback(&with_host("evil.example:1425")));

        // HTTP/2 sends :authority; axum surfaces it on the URI.
        let h2 = Request::builder()
            .uri("http://127.0.0.1:1425/ws/tasks/1").body(()).unwrap();
        assert!(request_host_is_loopback(&h2));

        // No Host at all is not a pass.
        let bare = Request::builder().uri("/ws/tasks/1").body(()).unwrap();
        assert!(!request_host_is_loopback(&bare));
    }

}
