// web.rs — Web search via DuckDuckGo HTML and generic HTTP fetch.
//
// These run server-side via reqwest to bypass the webview's CORS restrictions.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use tauri::Manager;

use crate::commands::ai_config::AiConfig;
use serde_json::Value;

// ── SSRF guard ─────────────────────────────────────────────────────────────
//
// `fetch_url` is `isSafe: true`, so the agent calls it with no confirmation, and
// the tool description tells the model to feed it URLs that came out of a web
// search. Untrusted content therefore reaches this function by design, and the
// documented flow is "read a page, then act on what it says".
//
// That is the whole SSRF chain: a page can carry text instructing the agent to
// fetch `http://127.0.0.1:14300/api/tasks` (this app's own REST server),
// `http://169.254.169.254/…` (cloud metadata), or any host on the user's LAN,
// and then to post what it found somewhere else. Nothing stopped it: the only
// check was that the URL started with http:// or https://.
//
// So: resolve the host and refuse any address that is not publicly routable.
// Deny by default, with an explicit host allowlist for the legitimate case
// (someone whose own service really does live on localhost).
//
// LIMIT, stated rather than papered over: the name is resolved here and again by
// reqwest when it connects, so a DNS entry that changes between the two calls
// (rebinding) can still slip through. Closing that needs a custom connector that
// checks the socket address it is about to use. This blocks the ordinary case —
// a literal private address or a name that plainly resolves to one — which is
// what the injection chain above actually relies on.

/// Is this address one the agent must never be pointed at?
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => {
            // ::ffff:a.b.c.d carries a v4 address — judge it as one, otherwise
            // ::ffff:127.0.0.1 walks straight past the v4 rules.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_v4(mapped);
            }
            is_blocked_v6(v6)
        }
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()            // 127.0.0.0/8
        || ip.is_private()      // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()   // 169.254/16 — cloud metadata lives here
        || ip.is_unspecified()  // 0.0.0.0
        || ip.is_broadcast()
        || ip.is_multicast()
        // 100.64.0.0/10 carrier-grade NAT (`is_shared` is still unstable).
        || (o[0] == 100 && (64..128).contains(&o[1]))
        // 192.0.0.0/24 IETF protocol assignments.
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // 198.18.0.0/15 benchmarking.
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    ip.is_loopback()             // ::1
        || ip.is_unspecified()   // ::
        || ip.is_multicast()
        || (seg[0] & 0xfe00) == 0xfc00   // fc00::/7  unique local
        || (seg[0] & 0xffc0) == 0xfe80   // fe80::/10 link local
}

/// Does `host` match an allowlist entry? Exact, case-insensitive, or a
/// `.suffix` match so "example.com" also covers "api.example.com".
fn host_allowed(host: &str, allow_hosts: &[String]) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    allow_hosts.iter().any(|raw| {
        let a = raw.trim().trim_end_matches('.').to_ascii_lowercase();
        !a.is_empty() && (h == a || h.ends_with(&format!(".{}", a)))
    })
}

/// Reject a URL that points anywhere other than the public internet.
///
/// Returns the parsed URL on success so the caller does not parse it twice.
async fn guard_url(url: &str, allow_hosts: &[String]) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Error: invalid url: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("Error: unsupported url scheme '{}': only http and https are allowed.", s)),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Error: url has no host.".to_string())?
        .to_string();

    if host_allowed(&host, allow_hosts) {
        return Ok(parsed);
    }

    let refusal = |what: &str| {
        format!(
            "Error: refusing to fetch {} — it resolves to {}, which is not a public address. \
             This guard exists because a page you fetch can tell you to read an internal \
             service and report back. If this host is genuinely yours, add it to \
             Settings → General → Fetch allowed hosts.",
            url, what
        )
    };

    // An IP literal needs no resolution.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(refusal(&ip.to_string()));
        }
        return Ok(parsed);
    }

    let port = parsed.port_or_known_default().unwrap_or(80);
    let mut addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("Error: could not resolve host '{}': {}", host, e))?
        .peekable();
    if addrs.peek().is_none() {
        return Err(format!("Error: host '{}' resolved to no addresses.", host));
    }
    // EVERY address must be public: one private answer among several is enough
    // to make the connection land somewhere internal.
    for addr in addrs {
        if is_blocked_ip(addr.ip()) {
            return Err(refusal(&addr.ip().to_string()));
        }
    }
    Ok(parsed)
}

/// Search the web using the Tavily API (https://api.tavily.com/search).
/// Reads the Tavily API Key from ai_config.json.
/// Returns the raw JSON response from Tavily.
#[tauri::command]
pub async fn web_search<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    query: String,
    proxy: Option<String>,
) -> Result<serde_json::Value, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("web_search requires a non-empty query".to_string());
    }

    // Read Tavily API key from config
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config_path = config_dir.join("ai_config.json");
    let api_key = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: AiConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        config.tavily_api_key
    } else {
        None
    };

    let api_key = match api_key {
        Some(k) if !k.is_empty() && k != "********" => k,
        _ => {
            return Err(
                "Tavily API key not found in settings. Please set it in Settings -> General."
                    .to_string(),
            )
        }
    };

    let mut builder = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(20));

    if let Some(p) = proxy {
        let p = p.trim();
        if !p.is_empty() {
            let px = reqwest::Proxy::all(p).map_err(|e| format!("Invalid proxy URL: {}", e))?;
            builder = builder.proxy(px);
        }
    }

    let client = builder.build().map_err(|e| e.to_string())?;

    let req_body = serde_json::json!({
        "api_key": api_key,
        "query": q,
        "search_depth": "basic",
        "include_answer": false,
        "include_images": false,
        "include_raw_content": false,
        "max_results": 5
    });

    let resp = client
        .post("https://api.tavily.com/search")
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("Tavily search request failed: {}", e))?;

    let status = resp.status();
    let body = resp
        .json::<Value>()
        .await
        .map_err(|e| format!("reading Tavily response failed: {}", e))?;

    if !status.is_success() {
        let err_msg = body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or_else(|| "Unknown error");
        return Err(format!(
            "Tavily search returned HTTP {}: {}",
            status, err_msg
        ));
    }

    Ok(body)
}

/// Generic HTTP GET fetch tool, capped at 500 KB to avoid flooding context.
/// Returns the raw text response prefixed with HTTP status and content type.
///
/// `allow_hosts` is the user's escape hatch (Settings → General → Fetch allowed
/// hosts), passed through by the caller. Absent/empty ⇒ nothing private is
/// reachable, which is the default — see the SSRF guard above.
#[tauri::command]
pub async fn fetch_url(
    url: String,
    headers: Option<Vec<(String, String)>>,
    proxy: Option<String>,
    allow_hosts: Option<Vec<String>>,
) -> Result<String, String> {
    // Enforced here, in the backend, rather than in the JS tool handler: the
    // handler is the layer an agent's own output can influence, and this is the
    // one that actually opens the socket.
    let allow_hosts_owned = allow_hosts.unwrap_or_default();
    guard_url(&url, &allow_hosts_owned).await?;

    let mut builder = reqwest::Client::builder()
        // Without this, a public URL that 302s to http://127.0.0.1/… lands
        // exactly where the guard just refused to go. Redirects are followed
        // manually below so each hop is checked.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 (compatible; JH-AI-Agent/1.0)")
        .timeout(Duration::from_secs(30));

    if let Some(p) = proxy {
        let p = p.trim();
        if !p.is_empty() {
            let px = reqwest::Proxy::all(p).map_err(|e| format!("Invalid proxy URL: {}", e))?;
            builder = builder.proxy(px);
        }
    }

    let client = builder.build().map_err(|e| e.to_string())?;
    let allowed = allow_hosts_owned;
    let hdrs = headers.unwrap_or_default();

    // Follow redirects by hand so every hop goes through the guard. reqwest's
    // own policy would follow a 302 into a private address without asking.
    const MAX_HOPS: usize = 10;
    let mut current = url.clone();
    let mut resp;
    let mut hops = 0usize;
    loop {
        let mut req = client.get(&current);
        for (k, v) in &hdrs {
            if let Ok(name) = reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
                if let Ok(value) = reqwest::header::HeaderValue::from_str(v) {
                    req = req.header(name, value);
                }
            }
        }
        let r = req
            .send()
            .await
            .map_err(|e| format!("fetch request failed: {}", e))?;

        if !r.status().is_redirection() {
            resp = r;
            break;
        }
        hops += 1;
        if hops > MAX_HOPS {
            return Err(format!("Error: too many redirects (>{}) starting at {}", MAX_HOPS, url));
        }
        let location = r
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("Error: {} returned a redirect with no Location header.", current))?
            .to_string();
        // Relative Locations are normal — resolve against the hop we just made.
        let base = reqwest::Url::parse(&current).map_err(|e| e.to_string())?;
        let next = base
            .join(&location)
            .map_err(|e| format!("Error: unusable redirect target '{}': {}", location, e))?;
        guard_url(next.as_str(), &allowed).await?;
        current = next.to_string();
    }

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let status_line = format!(
        "HTTP {} {} — Content-Type: {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Unknown"),
        content_type
    );

    let max_bytes = 500 * 1024; // 500 KB cap
    let mut total_bytes = 0;
    let mut chunks = Vec::new();
    let mut truncated = false;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("reading response failed: {}", e))?
    {
        if total_bytes + chunk.len() > max_bytes {
            let remaining = max_bytes - total_bytes;
            if remaining > 0 {
                chunks.extend_from_slice(&chunk[..remaining]);
            }
            truncated = true;
            break;
        } else {
            chunks.extend_from_slice(&chunk);
            total_bytes += chunk.len();
        }
    }

    let text = String::from_utf8_lossy(&chunks).to_string();
    let trunc_note = if truncated {
        "\n[Response truncated at 500 KB]"
    } else {
        ""
    };

    Ok(format!("{}\n\n{}{}", status_line, text, trunc_note))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// wiremock listens on loopback, which the SSRF guard blocks by design — so
    /// every mock-server test has to opt that host in, exactly as a user with a
    /// local service would.
    fn allow_loopback() -> Option<Vec<String>> {
        Some(vec!["127.0.0.1".to_string(), "localhost".to_string()])
    }

    #[tokio::test]
    async fn test_fetch_url_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/test"))
            .respond_with(ResponseTemplate::new(200).set_body_string("Hello, World!"))
            .mount(&mock_server)
            .await;

        let url = format!("{}/test", mock_server.uri());
        let res = fetch_url(url, None, None, allow_loopback()).await.unwrap();
        assert!(res.contains("HTTP 200 OK"));
        assert!(res.contains("Hello, World!"));
    }

    #[tokio::test]
    async fn test_fetch_url_truncate() {
        let mock_server = MockServer::start().await;
        let large_body = "A".repeat(600 * 1024);
        Mock::given(method("GET"))
            .and(path("/large"))
            .respond_with(ResponseTemplate::new(200).set_body_string(large_body))
            .mount(&mock_server)
            .await;

        let url = format!("{}/large", mock_server.uri());
        let res = fetch_url(url, None, None, allow_loopback()).await.unwrap();
        assert!(res.contains("[Response truncated at 500 KB]"));
        assert!(res.len() <= (500 * 1024) + 1000);
    }

    // ── SSRF guard ────────────────────────────────────────────────────────

    #[test]
    fn blocks_loopback_private_and_metadata_v4() {
        for ip in [
            "127.0.0.1", "127.13.9.2",      // loopback
            "10.0.0.5", "172.16.4.1", "192.168.1.1",  // RFC1918
            "169.254.169.254",              // cloud metadata
            "0.0.0.0", "255.255.255.255",
            "100.64.0.1",                   // carrier-grade NAT
            "198.18.0.1",                   // benchmarking
        ] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(is_blocked_ip(parsed), "{} should be blocked", ip);
        }
    }

    #[test]
    fn allows_ordinary_public_addresses() {
        for ip in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(!is_blocked_ip(parsed), "{} should be allowed", ip);
        }
    }

    #[test]
    fn blocks_v6_loopback_link_local_and_unique_local() {
        for ip in ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(is_blocked_ip(parsed), "{} should be blocked", ip);
        }
    }

    #[test]
    fn v4_mapped_v6_does_not_smuggle_loopback_through() {
        // ::ffff:127.0.0.1 is 127.0.0.1 wearing a v6 hat.
        let parsed: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(parsed));
    }

    #[test]
    fn host_allowlist_matches_exactly_and_by_suffix() {
        let allow = vec!["example.com".to_string(), "127.0.0.1".to_string()];
        assert!(host_allowed("example.com", &allow));
        assert!(host_allowed("api.example.com", &allow));
        assert!(host_allowed("EXAMPLE.COM", &allow));
        assert!(host_allowed("127.0.0.1", &allow));
        // A suffix match must not be a substring match.
        assert!(!host_allowed("notexample.com", &allow));
        assert!(!host_allowed("example.com.evil.test", &allow));
        assert!(!host_allowed("other.com", &allow));
    }

    #[tokio::test]
    async fn guard_refuses_a_literal_private_url() {
        let err = guard_url("http://169.254.169.254/latest/meta-data/", &[])
            .await
            .unwrap_err();
        assert!(err.contains("not a public address"), "unexpected: {}", err);
    }

    #[tokio::test]
    async fn guard_refuses_this_apps_own_rest_server() {
        let err = guard_url("http://127.0.0.1:14300/api/tasks", &[]).await.unwrap_err();
        assert!(err.contains("not a public address"), "unexpected: {}", err);
    }

    #[tokio::test]
    async fn guard_allows_a_private_url_the_user_opted_in_to() {
        assert!(guard_url("http://127.0.0.1:14300/api/tasks", &["127.0.0.1".to_string()])
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn guard_refuses_non_http_schemes() {
        for u in ["file:///C:/Windows/win.ini", "ftp://example.com/x", "gopher://example.com"] {
            let err = guard_url(u, &[]).await.unwrap_err();
            assert!(err.contains("scheme"), "unexpected for {}: {}", u, err);
        }
    }

    #[tokio::test]
    async fn a_redirect_into_loopback_is_refused() {
        // The case client-side redirect following would have walked straight
        // into: the first hop is allowed, the second points at localhost.
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/bounce"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", "http://169.254.169.254/latest/meta-data/"),
            )
            .mount(&mock_server)
            .await;

        let url = format!("{}/bounce", mock_server.uri());
        let err = fetch_url(url, None, None, allow_loopback()).await.unwrap_err();
        assert!(err.contains("not a public address"), "unexpected: {}", err);
    }
}
