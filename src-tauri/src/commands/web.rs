// web.rs — self-built web search (no external API key).
//
// Runs server-side via reqwest so it BYPASSES the webview's CORS: DuckDuckGo's
// HTML endpoint sends no `Access-Control-Allow-Origin`, so a browser `fetch()`
// from the renderer would be blocked. We fetch here and return the raw results
// HTML; the JS handler parses it with DOMParser into {title, url, snippet}.
//
// The point is to stop the LLM guessing URLs from memory (a frequent source of
// 404s): it searches by QUERY, then fetch_url's a REAL result link.

use std::time::Duration;

/// Fetch DuckDuckGo's HTML search results for `query`. Honors the configured
/// HTTP/SOCKS proxy (same as LLM calls). Returns the raw HTML on success.
#[tauri::command]
pub async fn web_search(query: String, proxy: Option<String>) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("web_search requires a non-empty query".to_string());
    }

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
    let resp = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", q), ("kl", "wt-wt")])
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await
        .map_err(|e| format!("search request failed: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading search response failed: {}", e))?;

    if !status.is_success() {
        return Err(format!("search returned HTTP {}", status));
    }
    Ok(body)
}
