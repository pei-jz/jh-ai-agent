// web.rs — Web search via DuckDuckGo HTML and generic HTTP fetch.
//
// These run server-side via reqwest to bypass the webview's CORS restrictions.

use std::time::Duration;
use tauri::Manager;

use crate::commands::ai_config::AiConfig;
use serde_json::Value;

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
#[tauri::command]
pub async fn fetch_url(
    url: String,
    headers: Option<Vec<(String, String)>>,
    proxy: Option<String>,
) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Error: url must start with http:// or https://".to_string());
    }

    let mut builder = reqwest::Client::builder()
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

    let mut req = client.get(&url);

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            if let Ok(name) = reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
                if let Ok(value) = reqwest::header::HeaderValue::from_str(&v) {
                    req = req.header(name, value);
                }
            }
        }
    }

    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("fetch request failed: {}", e))?;
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

    #[tokio::test]
    async fn test_fetch_url_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/test"))
            .respond_with(ResponseTemplate::new(200).set_body_string("Hello, World!"))
            .mount(&mock_server)
            .await;

        let url = format!("{}/test", mock_server.uri());
        let res = fetch_url(url, None, None).await.unwrap();
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
        let res = fetch_url(url, None, None).await.unwrap();
        assert!(res.contains("[Response truncated at 500 KB]"));
        assert!(res.len() <= (500 * 1024) + 1000);
    }
}
