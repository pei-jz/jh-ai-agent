// ai_providers — pure, provider-specific helper functions extracted from
// commands/ai.rs (Part A refactor). These build request payloads and translate
// tool/schema formats per provider; none touch the network or AppHandle, so
// they're unit-tested in isolation (see the test modules at the bottom).
//
// The streaming dispatcher `llm_chat_native` stays in ai.rs and calls these via
// `use super::ai_providers::{...}`.

use super::ai::LlmMessage;

/// Whether a model accepts image (vision) content. Non-vision models served via
/// an OpenAI-compatible endpoint (e.g. DeepSeek) reject `image_url` content parts
/// with a 400 "unknown variant image_url" — so we must send text-only to them.
pub(crate) fn model_supports_vision(provider: &str, model: &str) -> bool {
    let m = model.to_lowercase();
    match provider {
        // Modern Claude 3+ and all Gemini models are multimodal.
        "gemini" | "anthropic" => true,
        // For OpenAI-compatible endpoints, only KNOWN vision-capable model
        // families get images. Unknown ones (DeepSeek, most local models) default
        // to text-only to avoid the 400 error.
        "openai" | "azure" | "generic" => {
            // Treat the whole GPT family + reasoning o-series as vision-capable so
            // future models qualify automatically. Known text-only OpenAI-compatible
            // models (DeepSeek etc.) don't contain "gpt"/"chatgpt" and are excluded.
            m.contains("gpt") || m.contains("chatgpt")
                || m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4")
                || m.contains("-o1") || m.contains("-o3") || m.contains("-o4")
        }
        _ => false,
    }
}

/// Parse a frontend image data-URL ("data:<mime>;base64,<data>") into (mime, data).
/// Falls back to ("image/png", raw) for bare base64 (legacy callers). Pure.
pub(crate) fn parse_image_data_url(s: &str) -> (String, String) {
    if let Some(rest) = s.strip_prefix("data:") {
        if let Some(semi) = rest.find(';') {
            let mime = rest[..semi].to_string();
            let after = &rest[semi + 1..];
            if let Some(data) = after.strip_prefix("base64,") {
                return (mime, data.to_string());
            }
        }
    }
    ("image/png".to_string(), s.to_string())
}

/// Build the OpenAI-compatible `messages` array (system + turns). Attaches images
/// to the last user turn ONLY when the model supports vision; otherwise drops them
/// with an explanatory note (non-vision models 400 on `image_url`). Pure.
pub(crate) fn build_openai_messages(
    system_prompt: Option<String>,
    messages: Vec<LlmMessage>,
    images: &Option<Vec<String>>,
    vision_ok: bool,
) -> Vec<serde_json::Value> {
    let mut full = Vec::new();
    if let Some(sys) = system_prompt {
        full.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    let has_images = images.as_ref().map_or(false, |i| !i.is_empty());
    let msg_len = messages.len();
    for (i, m) in messages.into_iter().enumerate() {
        let is_last_user = m.role == "user" && i + 1 == msg_len;
        if is_last_user && has_images && vision_ok {
            let mut parts = vec![serde_json::json!({ "type": "text", "text": m.content })];
            if let Some(imgs) = images {
                for img in imgs {
                    let (mime, data) = parse_image_data_url(img);
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{};base64,{}", mime, data) }
                    }));
                }
            }
            full.push(serde_json::json!({ "role": m.role, "content": parts }));
        } else if is_last_user && has_images && !vision_ok {
            let n = images.as_ref().map(|v| v.len()).unwrap_or(0);
            let note = format!(
                "{}\n\n[Note: {} image(s) were attached but the current model does not support image input, so they were omitted.]",
                m.content, n
            );
            full.push(serde_json::json!({ "role": m.role, "content": note }));
        } else {
            full.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
    }
    full
}

/// Split a system prompt on the cache-break sentinel into (stable, volatile).
///
/// OpenAI-family providers cache on EXACT prefix match only (no breakpoints à la
/// Anthropic `cache_control`). If the volatile tail (task_plan / workflow phase /
/// artifacts) stays inside the system message, the FIRST message changes every
/// agent step and the automatic prefix cache never hits. Callers keep the stable
/// part as the system message and re-inject the volatile part as a trailing user
/// message instead. Pure.
pub(crate) fn split_system_on_cache_break(sys: &str, sentinel: &str) -> (String, Option<String>) {
    match sys.find(sentinel) {
        Some(idx) => {
            let stable = sys[..idx].trim_end().to_string();
            let volatile = sys[idx + sentinel.len()..].trim().to_string();
            let vol = if volatile.is_empty() { None } else { Some(volatile) };
            (stable, vol)
        }
        None => (sys.to_string(), None),
    }
}

// ── Tool-definition helpers (Structured Outputs / strict) ──────────────────

/// Prepare OpenAI-format tools for the request body: strip the `_strict_ok`
/// hint added by the frontend and, when the provider supports OpenAI Structured
/// Outputs, set `function.strict = true` on tools whose schema is strict-eligible.
pub(crate) fn clean_openai_tools(tools: &serde_json::Value, strict_supported: bool) -> serde_json::Value {
    let arr = match tools.as_array() {
        Some(a) => a,
        None => return tools.clone(),
    };
    let cleaned: Vec<serde_json::Value> = arr
        .iter()
        .map(|t| {
            let mut tool = t.clone();
            let strict_ok = tool
                .get("_strict_ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if let Some(obj) = tool.as_object_mut() {
                obj.remove("_strict_ok");
                if strict_supported && strict_ok {
                    if let Some(func) = obj.get_mut("function").and_then(|f| f.as_object_mut()) {
                        func.insert("strict".to_string(), serde_json::json!(true));
                    }
                }
            }
            tool
        })
        .collect();
    serde_json::Value::Array(cleaned)
}

/// Convert OpenAI-format tools to Gemini `functionDeclarations`. Returns None
/// when there are no usable tools.
pub(crate) fn openai_tools_to_gemini(tools: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    let arr = tools.as_array()?;
    let decls: Vec<serde_json::Value> = arr
        .iter()
        .filter_map(|t| {
            let f = &t["function"];
            let name = f["name"].as_str()?;
            let mut decl = serde_json::Map::new();
            decl.insert("name".to_string(), serde_json::json!(name));
            decl.insert(
                "description".to_string(),
                serde_json::json!(f["description"].as_str().unwrap_or("")),
            );
            // Gemini rejects an empty-parameters function declaration's schema if
            // it has no properties; only attach parameters when there are some.
            let params = gemini_schema(&f["parameters"]);
            if params
                .get("properties")
                .and_then(|p| p.as_object())
                .map(|o| !o.is_empty())
                .unwrap_or(false)
            {
                decl.insert("parameters".to_string(), params);
            }
            Some(serde_json::Value::Object(decl))
        })
        .collect();
    if decls.is_empty() {
        None
    } else {
        Some(decls)
    }
}

/// Transform a JSON-Schema node into Gemini's OpenAPI-subset Schema:
///   • `type` uppercased (STRING/NUMBER/INTEGER/BOOLEAN/ARRAY/OBJECT)
///   • union `["string","null"]` → type STRING + `nullable: true`
///   • `additionalProperties`, `strict`, `title` dropped (unsupported)
///   • `null` removed from `enum`
///   • recurses into `properties` and `items`
fn gemini_schema(node: &serde_json::Value) -> serde_json::Value {
    let obj = match node.as_object() {
        Some(o) => o,
        None => return serde_json::json!({}),
    };
    let mut out = serde_json::Map::new();
    let mut nullable = false;

    // type (string or array form)
    if let Some(t) = obj.get("type") {
        let mut chosen: Option<String> = None;
        match t {
            serde_json::Value::String(s) => chosen = Some(s.clone()),
            serde_json::Value::Array(types) => {
                for ty in types {
                    if let Some(s) = ty.as_str() {
                        if s == "null" {
                            nullable = true;
                        } else if chosen.is_none() {
                            chosen = Some(s.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
        if let Some(s) = chosen {
            out.insert("type".to_string(), serde_json::json!(gemini_type(&s)));
        }
    }
    if nullable {
        out.insert("nullable".to_string(), serde_json::json!(true));
    }

    if let Some(desc) = obj.get("description").and_then(|d| d.as_str()) {
        out.insert("description".to_string(), serde_json::json!(desc));
    }

    // enum (strip null entries)
    if let Some(en) = obj.get("enum").and_then(|e| e.as_array()) {
        let vals: Vec<serde_json::Value> =
            en.iter().filter(|v| !v.is_null()).cloned().collect();
        if !vals.is_empty() {
            out.insert("enum".to_string(), serde_json::Value::Array(vals));
        }
    }

    // properties (recurse)
    if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
        let mut new_props = serde_json::Map::new();
        for (k, v) in props {
            new_props.insert(k.clone(), gemini_schema(v));
        }
        out.insert("properties".to_string(), serde_json::Value::Object(new_props));
    }

    // required (passthrough)
    if let Some(req) = obj.get("required").and_then(|r| r.as_array()) {
        out.insert("required".to_string(), serde_json::Value::Array(req.clone()));
    }

    // items (recurse)
    if let Some(items) = obj.get("items") {
        out.insert("items".to_string(), gemini_schema(items));
    }

    serde_json::Value::Object(out)
}

/// Map a JSON-Schema primitive type name to Gemini's uppercase Type enum.
fn gemini_type(t: &str) -> &'static str {
    match t {
        "string" => "STRING",
        "number" => "NUMBER",
        "integer" => "INTEGER",
        "boolean" => "BOOLEAN",
        "array" => "ARRAY",
        "object" => "OBJECT",
        _ => "STRING",
    }
}

#[cfg(test)]
mod strict_tool_tests {
    use super::*;

    fn sample_tools() -> serde_json::Value {
        serde_json::json!([
            {
                "type": "function",
                "_strict_ok": true,
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "limit": { "type": ["integer", "null"] }
                        },
                        "required": ["path", "limit"],
                        "additionalProperties": false
                    }
                }
            },
            {
                "type": "function",
                "_strict_ok": false,
                "function": {
                    "name": "weird_mcp",
                    "description": "third-party",
                    "parameters": { "type": "object", "properties": { "x": { "type": "string" } } }
                }
            }
        ])
    }

    #[test]
    fn clean_sets_strict_only_when_supported_and_eligible() {
        let cleaned = clean_openai_tools(&sample_tools(), true);
        let arr = cleaned.as_array().unwrap();
        // _strict_ok removed everywhere
        assert!(arr.iter().all(|t| t.get("_strict_ok").is_none()));
        // eligible tool gets strict:true
        assert_eq!(arr[0]["function"]["strict"], serde_json::json!(true));
        // ineligible tool does NOT
        assert!(arr[1]["function"].get("strict").is_none());
    }

    #[test]
    fn clean_never_sets_strict_when_unsupported() {
        let cleaned = clean_openai_tools(&sample_tools(), false);
        let arr = cleaned.as_array().unwrap();
        assert!(arr[0]["function"].get("strict").is_none());
        assert!(arr.iter().all(|t| t.get("_strict_ok").is_none()));
    }

    #[test]
    fn gemini_schema_uppercases_type_and_marks_nullable() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "limit": { "type": ["integer", "null"] }
            },
            "required": ["path", "limit"],
            "additionalProperties": false
        });
        let g = gemini_schema(&schema);
        assert_eq!(g["type"], serde_json::json!("OBJECT"));
        assert_eq!(g["properties"]["path"]["type"], serde_json::json!("STRING"));
        assert_eq!(g["properties"]["limit"]["type"], serde_json::json!("INTEGER"));
        assert_eq!(g["properties"]["limit"]["nullable"], serde_json::json!(true));
        // additionalProperties dropped
        assert!(g.get("additionalProperties").is_none());
        // required preserved
        assert_eq!(g["required"], serde_json::json!(["path", "limit"]));
    }

    #[test]
    fn gemini_schema_strips_null_from_enum() {
        let schema = serde_json::json!({
            "type": ["string", "null"],
            "enum": ["a", "b", null]
        });
        let g = gemini_schema(&schema);
        assert_eq!(g["type"], serde_json::json!("STRING"));
        assert_eq!(g["nullable"], serde_json::json!(true));
        assert_eq!(g["enum"], serde_json::json!(["a", "b"]));
    }

    #[test]
    fn tools_to_gemini_maps_declarations() {
        let decls = openai_tools_to_gemini(&sample_tools()).unwrap();
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0]["name"], serde_json::json!("read_file"));
        assert_eq!(decls[0]["parameters"]["type"], serde_json::json!("OBJECT"));
    }
}

#[cfg(test)]
mod provider_helper_tests {
    use super::*;

    #[test]
    fn vision_support_by_provider_and_model() {
        // GPT family + reasoning o-series → vision.
        assert!(model_supports_vision("openai", "gpt-4o"));
        assert!(model_supports_vision("openai", "gpt-5-mini"));
        assert!(model_supports_vision("openai", "o3"));
        assert!(model_supports_vision("azure", "chatgpt-4o-latest"));
        // gemini / anthropic always multimodal.
        assert!(model_supports_vision("gemini", "gemini-2.5-flash"));
        assert!(model_supports_vision("anthropic", "claude-sonnet-4"));
        // DeepSeek and other text-only OpenAI-compatible models → no vision.
        assert!(!model_supports_vision("openai", "deepseek-v4-pro"));
        assert!(!model_supports_vision("generic", "qwen2.5-coder"));
        assert!(!model_supports_vision("ollama", "llama3"));
    }

    #[test]
    fn parse_image_data_url_extracts_mime_and_data() {
        let (mime, data) = parse_image_data_url("data:image/jpeg;base64,QUJD");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(data, "QUJD");
        // Bare base64 → png fallback.
        let (mime2, data2) = parse_image_data_url("QUJD");
        assert_eq!(mime2, "image/png");
        assert_eq!(data2, "QUJD");
    }

    fn msgs() -> Vec<LlmMessage> {
        vec![
            LlmMessage { role: "user".into(), content: "describe this".into() },
        ]
    }

    #[test]
    fn build_messages_prepends_system_and_keeps_text_when_no_images() {
        let out = build_openai_messages(Some("SYS".into()), msgs(), &None, true);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[0]["content"], "SYS");
        assert_eq!(out[1]["content"], "describe this"); // plain string, no parts
    }

    #[test]
    fn build_messages_attaches_image_url_for_vision_model() {
        let imgs = Some(vec!["data:image/png;base64,QQ==".to_string()]);
        let out = build_openai_messages(None, msgs(), &imgs, true);
        let parts = out[0]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert!(parts[1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn build_messages_drops_images_with_note_for_non_vision_model() {
        let imgs = Some(vec!["data:image/png;base64,QQ==".to_string()]);
        let out = build_openai_messages(None, msgs(), &imgs, false);
        let content = out[0]["content"].as_str().unwrap();
        assert!(content.starts_with("describe this"));
        assert!(content.contains("does not support image input"));
        assert!(!content.contains("image_url"));
    }

    #[test]
    fn split_system_separates_stable_and_volatile() {
        const BREAK: &str = "<<<JHAI_SYSTEM_CACHE_BREAK>>>";
        let sys = format!("STABLE RULES\n{}\n<task_plan>...</task_plan>", BREAK);
        let (stable, volatile) = split_system_on_cache_break(&sys, BREAK);
        assert_eq!(stable, "STABLE RULES");
        assert_eq!(volatile.as_deref(), Some("<task_plan>...</task_plan>"));
    }

    #[test]
    fn split_system_no_sentinel_returns_whole_as_stable() {
        const BREAK: &str = "<<<JHAI_SYSTEM_CACHE_BREAK>>>";
        let (stable, volatile) = split_system_on_cache_break("ALL STABLE", BREAK);
        assert_eq!(stable, "ALL STABLE");
        assert!(volatile.is_none());
    }

    #[test]
    fn split_system_empty_volatile_is_none() {
        const BREAK: &str = "<<<JHAI_SYSTEM_CACHE_BREAK>>>";
        let sys = format!("STABLE\n{}\n   \n", BREAK);
        let (stable, volatile) = split_system_on_cache_break(&sys, BREAK);
        assert_eq!(stable, "STABLE");
        assert!(volatile.is_none());
    }
}
