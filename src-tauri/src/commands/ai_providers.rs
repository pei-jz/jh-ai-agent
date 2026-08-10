// ai_providers — pure, provider-specific helper functions extracted from
// commands/ai.rs (Part A refactor). These build request payloads and translate
// tool/schema formats per provider; none touch the network or AppHandle, so
// they're unit-tested in isolation (see the test modules at the bottom).
//
// The streaming dispatcher `llm_chat_native` stays in ai.rs and calls these via
// `use super::ai_providers::{...}`.

use super::ai::LlmMessage;

/// Sentinel splitting the cacheable system prefix from the volatile suffix.
/// Emitted by ContextBuilder.js (SYSTEM_CACHE_BREAK).
pub(crate) const SYS_CACHE_BREAK: &str = "<<<JHAI_SYSTEM_CACHE_BREAK>>>";

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
        // ── Native tool-call turns (standards-aligned history) ──────────
        // assistant + tool_calls and role:"tool" results pass through in the
        // OpenAI wire format. A tool message WITHOUT an id (shouldn't happen,
        // but a compacted/legacy history could) is downgraded to user text —
        // sending it as role:"tool" would 400.
        if m.role == "assistant" && m.tool_calls.is_some() {
            full.push(serde_json::json!({
                "role": "assistant",
                "content": if m.content.is_empty() { serde_json::Value::Null } else { serde_json::json!(m.content) },
                "tool_calls": m.tool_calls.unwrap()
            }));
            continue;
        }
        if m.role == "tool" {
            match m.tool_call_id {
                Some(id) => full.push(serde_json::json!({
                    "role": "tool", "tool_call_id": id, "content": m.content
                })),
                None => full.push(serde_json::json!({
                    "role": "user",
                    "content": format!("[Tool result{}]\n{}",
                        m.name.map(|n| format!(" — {}", n)).unwrap_or_default(), m.content)
                })),
            }
            continue;
        }

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
            LlmMessage { role: "user".into(), content: "describe this".into(), ..Default::default() },
        ]
    }

    #[test]
    fn build_messages_passes_native_tool_turns_through() {
        let tc = serde_json::json!([{
            "id": "call_1", "type": "function",
            "function": { "name": "read_file", "arguments": "{\"path\":\"a.js\"}" }
        }]);
        let ms = vec![
            LlmMessage { role: "assistant".into(), content: "reading the file".into(), tool_calls: Some(tc.clone()), ..Default::default() },
            LlmMessage { role: "tool".into(), content: "file body".into(), tool_call_id: Some("call_1".into()), name: Some("read_file".into()), ..Default::default() },
        ];
        let out = build_openai_messages(None, ms, &None, true);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["tool_calls"], tc);
        assert_eq!(out[1]["role"], "tool");
        assert_eq!(out[1]["tool_call_id"], "call_1");
        assert_eq!(out[1]["content"], "file body");
    }

    #[test]
    fn build_messages_downgrades_orphan_tool_message_to_user_text() {
        // A tool result without an id (legacy/compacted history) must NOT go out
        // as role:"tool" — providers 400 on it. It becomes readable user text.
        let ms = vec![
            LlmMessage { role: "tool".into(), content: "result".into(), name: Some("grep_search".into()), ..Default::default() },
        ];
        let out = build_openai_messages(None, ms, &None, true);
        assert_eq!(out[0]["role"], "user");
        let c = out[0]["content"].as_str().unwrap();
        assert!(c.contains("grep_search"));
        assert!(c.contains("result"));
    }

    #[test]
    fn build_messages_empty_assistant_content_with_tool_calls_is_null() {
        let tc = serde_json::json!([{ "id": "c", "type": "function", "function": { "name": "x", "arguments": "{}" } }]);
        let ms = vec![
            LlmMessage { role: "assistant".into(), content: "".into(), tool_calls: Some(tc), ..Default::default() },
        ];
        let out = build_openai_messages(None, ms, &None, true);
        assert!(out[0]["content"].is_null());
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

/// Build the provider-specific request body (OpenAI-family / Anthropic / Gemini)
/// for `llm_chat_native`. Consumes `payload.messages` (and, for Gemini, the
/// system prompt) via the &mut borrow; other payload fields are left for the
/// caller. Behaviour is identical to the former inline `match` in ai.rs.
pub(crate) fn build_request_body(
    provider: &str,
    model: &str,
    messages: Vec<LlmMessage>,
    system_prompt: Option<String>,
    images: &Option<Vec<String>>,
    tools: &Option<serde_json::Value>,
    resolved_max_tokens: Option<u32>,
    resolved_temperature: Option<f32>,
) -> serde_json::Value {
    match provider {
        "openai" | "ollama" | "azure" | "generic" => {
            // Message array (incl. vision attach/drop) → build_openai_messages (unit-tested).
            //
            // ── Prompt caching (OpenAI-family: automatic prefix cache) ──
            // OpenAI/Azure/DeepSeek cache on EXACT prefix match only — no
            // breakpoints like Anthropic's cache_control. The system prompt's
            // VOLATILE tail (task_plan / workflow phase / artifacts) used to be
            // folded into the system message, so the FIRST message changed every
            // agent step and the prefix cache never hit (observed: cached_tokens
            // ≈ 0 on Azure). Split on the sentinel instead: the STABLE region
            // stays the system message (byte-identical all run → system + tools
            // + history prefix stays cacheable), and the volatile region is
            // re-injected as a clearly-labeled FINAL user message below.
            let vision_ok = model_supports_vision(provider, &model);
            let (sys_stable, sys_volatile) = match system_prompt {
                Some(s) => {
                    let (stable, volatile) = split_system_on_cache_break(&s, SYS_CACHE_BREAK);
                    (Some(stable), volatile)
                }
                None => (None, None),
            };
            let msgs = messages;
            let mut full_messages = build_openai_messages(sys_stable, msgs, images, vision_ok);
            if let Some(vol) = sys_volatile {
                full_messages.push(serde_json::json!({
                    "role": "user",
                    "content": format!(
                        "[Current Task Context — treat as system-level instructions; auto-updated each step]\n{}",
                        vol
                    )
                }));
            }
            let mut body_obj = serde_json::json!({
                "model": model,
                "messages": full_messages,
                "stream": true,
                // Ask OpenAI-compatible endpoints to emit a final usage-only chunk
                // (choices:[] + usage:{...}). Unknown-field-tolerant servers ignore
                // it; those that honor it give us real token counts.
                "stream_options": { "include_usage": true }
            });
            // Response-control params (OpenAI-compatible): only set when provided,
            // so unconfigured connections keep the provider's default behavior.
            if let Some(obj) = body_obj.as_object_mut() {
                if let Some(mt) = resolved_max_tokens {
                    obj.insert("max_tokens".to_string(), serde_json::json!(mt));
                }
                if let Some(temp) = resolved_temperature {
                    obj.insert("temperature".to_string(), serde_json::json!(temp));
                }
            }
            // Forward native tool definitions if provided. Excluded for "ollama"
            // (its OpenAI-compat layer doesn't reliably support function calling
            // — falls back to text JSON via the system prompt).
            if provider != "ollama" {
                if let Some(tools) = tools {
                    // OpenAI Structured Outputs (strict) is supported by openai,
                    // azure, and (opt-in) generic OpenAI-compatible endpoints.
                    let strict_supported =
                        matches!(provider, "openai" | "azure" | "generic");
                    let cleaned = clean_openai_tools(tools, strict_supported);
                    if let Some(obj) = body_obj.as_object_mut() {
                        obj.insert("tools".to_string(), cleaned);
                        obj.insert("tool_choice".to_string(), serde_json::json!("auto"));
                    }
                }
            }
            body_obj
        }
        "anthropic" => {
            let mut full_messages: Vec<serde_json::Value> = Vec::new();
            let msgs = messages;
            let msg_len = msgs.len();
            for (i, m) in msgs.into_iter().enumerate() {
                // ── Native tool-call turns → Anthropic content blocks ──────
                // assistant + tool_calls → [{text?}, {tool_use, id, name, input}…]
                // role:"tool"            → user turn with tool_result block(s);
                //                          CONSECUTIVE tool results merge into ONE
                //                          user turn (Anthropic requires results in
                //                          the immediately-following user message).
                if m.role == "assistant" && m.tool_calls.is_some() {
                    let mut blocks: Vec<serde_json::Value> = Vec::new();
                    if !m.content.trim().is_empty() {
                        blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
                    }
                    if let Some(arr) = m.tool_calls.as_ref().and_then(|v| v.as_array()) {
                        for tc in arr {
                            let f = &tc["function"];
                            let input: serde_json::Value = f["arguments"].as_str()
                                .and_then(|s| serde_json::from_str(s).ok())
                                .unwrap_or_else(|| serde_json::json!({}));
                            blocks.push(serde_json::json!({
                                "type": "tool_use",
                                "id": tc["id"].as_str().unwrap_or("call_0"),
                                "name": f["name"].as_str().unwrap_or(""),
                                "input": input
                            }));
                        }
                    }
                    full_messages.push(serde_json::json!({ "role": "assistant", "content": blocks }));
                    continue;
                }
                if m.role == "tool" {
                    let result_block = serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.clone().unwrap_or_else(|| "call_0".to_string()),
                        "content": m.content
                    });
                    // Merge into the previous user turn if it's already a
                    // tool_result container (consecutive results of one step).
                    let merged = if let Some(last) = full_messages.last_mut() {
                        let is_result_turn = last["role"] == "user"
                            && last["content"].as_array()
                                .map_or(false, |a| a.iter().all(|b| b["type"] == "tool_result"));
                        if is_result_turn {
                            last["content"].as_array_mut().unwrap().push(result_block.clone());
                            true
                        } else { false }
                    } else { false };
                    if !merged {
                        full_messages.push(serde_json::json!({ "role": "user", "content": [result_block] }));
                    }
                    continue;
                }

                if m.role == "user" && i == msg_len - 1 && images.as_ref().map_or(false, |imgs| !imgs.is_empty()) {
                    let mut content_parts = Vec::new();
                    content_parts.push(serde_json::json!({ "type": "text", "text": m.content }));

                    if let Some(images) = images {
                        for img in images {
                            let (mime, data) = parse_image_data_url(img);
                            content_parts.push(serde_json::json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime,
                                    "data": data
                                }
                            }));
                        }
                    }
                    full_messages.push(serde_json::json!({ "role": m.role, "content": content_parts }));
                } else {
                    full_messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
                }
            }

            // ── Conversation-history caching ───────────────────────────────
            // Mark the LAST message block with cache_control so the growing
            // history is billed incrementally: on the next step the prior turns
            // are a cached prefix (~10%), and only the newest turn is full price.
            // String content must be promoted to block form to carry the marker.
            if let Some(last) = full_messages.last_mut() {
                if last["content"].is_string() {
                    let text = last["content"].as_str().unwrap_or("").to_string();
                    last["content"] = serde_json::json!([
                        { "type": "text", "text": text, "cache_control": { "type": "ephemeral" } }
                    ]);
                } else if let Some(arr) = last["content"].as_array_mut() {
                    if let Some(lp) = arr.last_mut() {
                        lp["cache_control"] = serde_json::json!({ "type": "ephemeral" });
                    }
                }
            }
            {
                // Anthropic REQUIRES max_tokens. Use the configured value, else a
                // sane 8192 default (previously a hardcoded 8096 — a typo that also
                // ignored model capability). temperature is optional.
                let mut body = serde_json::json!({
                    "model": model,
                    "messages": full_messages,
                    "stream": true,
                    "max_tokens": resolved_max_tokens.unwrap_or(8192)
                });
                if let Some(temp) = resolved_temperature {
                    body["temperature"] = serde_json::json!(temp);
                }

                // ── Prompt caching (Anthropic, GA — no beta header needed) ──
                // The system prompt is split on SYS_CACHE_BREAK into a STABLE prefix
                // (persona + tool rules + project summary + memory…) and a VOLATILE
                // suffix (task_plan / workflow / artifacts). Only the prefix carries
                // `cache_control`, so the large static block is billed at ~10% on
                // cache hits while the changing tail doesn't bust the cached prefix.
                // (No sentinel ⇒ legacy single cached block.)
                if let Some(sys) = system_prompt.clone().filter(|s| !s.is_empty()) {
                    if let Some(idx) = sys.find(SYS_CACHE_BREAK) {
                        let prefix = sys[..idx].to_string();
                        let suffix = sys[idx + SYS_CACHE_BREAK.len()..].to_string();
                        let mut blocks = Vec::new();
                        if !prefix.trim().is_empty() {
                            blocks.push(serde_json::json!({
                                "type": "text", "text": prefix,
                                "cache_control": { "type": "ephemeral" }
                            }));
                        }
                        if !suffix.trim().is_empty() {
                            blocks.push(serde_json::json!({ "type": "text", "text": suffix }));
                        }
                        body["system"] = serde_json::Value::Array(blocks);
                    } else {
                        body["system"] = serde_json::json!([
                            { "type": "text", "text": sys, "cache_control": { "type": "ephemeral" } }
                        ]);
                    }
                }

                // Convert OpenAI-format tools to Anthropic format:
                // { type, function: { name, description, parameters } }
                // → { name, description, input_schema }
                if let Some(tools) = tools {
                    if let Some(arr) = tools.as_array() {
                        let mut anthropic_tools: Vec<serde_json::Value> = arr.iter()
                            .filter_map(|t| {
                                let f = &t["function"];
                                let name = f["name"].as_str()?;
                                Some(serde_json::json!({
                                    "name": name,
                                    "description": f["description"].as_str().unwrap_or(""),
                                    "input_schema": f["parameters"].clone()
                                }))
                            })
                            .collect();
                        if !anthropic_tools.is_empty() {
                            // Cache the (static) tool definitions too — mark the last
                            // tool, which caches the whole tools block up to that point.
                            if let Some(last) = anthropic_tools.last_mut() {
                                last["cache_control"] = serde_json::json!({ "type": "ephemeral" });
                            }
                            body["tools"] = serde_json::Value::Array(anthropic_tools);
                        }
                    }
                }
                body
            }
        }
        "gemini" => {
            let mut contents = Vec::new();
            let msgs = messages;
            let msg_len = msgs.len();
            for (i, m) in msgs.into_iter().enumerate() {
                // ── Native tool-call turns → Gemini parts ──────────────────
                // assistant + tool_calls → role "model" with functionCall parts;
                // role:"tool" → role "user" with a functionResponse part (v1beta
                // matches responses to calls by NAME + order, not id).
                if m.role == "assistant" && m.tool_calls.is_some() {
                    let mut parts = Vec::new();
                    if !m.content.trim().is_empty() {
                        parts.push(serde_json::json!({ "text": m.content }));
                    }
                    if let Some(arr) = m.tool_calls.as_ref().and_then(|v| v.as_array()) {
                        for tc in arr {
                            let f = &tc["function"];
                            let args: serde_json::Value = f["arguments"].as_str()
                                .and_then(|s| serde_json::from_str(s).ok())
                                .unwrap_or_else(|| serde_json::json!({}));
                            parts.push(serde_json::json!({
                                "functionCall": { "name": f["name"].as_str().unwrap_or(""), "args": args }
                            }));
                        }
                    }
                    contents.push(serde_json::json!({ "role": "model", "parts": parts }));
                    continue;
                }
                if m.role == "tool" {
                    contents.push(serde_json::json!({
                        "role": "user",
                        "parts": [{
                            "functionResponse": {
                                "name": m.name.clone().unwrap_or_else(|| "tool".to_string()),
                                "response": { "result": m.content }
                            }
                        }]
                    }));
                    continue;
                }

                let role = if m.role == "assistant" { "model" } else { "user" };
                let mut parts = Vec::new();
                parts.push(serde_json::json!({ "text": m.content }));

                // Attach images to the last user message
                if m.role == "user" && i == msg_len - 1 {
                    if let Some(images) = images {
                        for img in images {
                            let (mime, data) = parse_image_data_url(img);
                            parts.push(serde_json::json!({
                                "inline_data": {
                                    "mime_type": mime,
                                    "data": data
                                }
                            }));
                        }
                    }
                }

                contents.push(serde_json::json!({
                    "role": role,
                    "parts": parts
                }));
            }
            // Build optional generationConfig (maxOutputTokens / temperature).
            let mut gen_config = serde_json::Map::new();
            if let Some(mt) = resolved_max_tokens {
                gen_config.insert("maxOutputTokens".to_string(), serde_json::json!(mt));
            }
            if let Some(temp) = resolved_temperature {
                gen_config.insert("temperature".to_string(), serde_json::json!(temp));
            }

            let mut g_body = if let Some(sys) = system_prompt.map(|s| s.replace(SYS_CACHE_BREAK, "\n")) {
                serde_json::json!({
                    "contents": contents,
                    "system_instruction": {
                        "parts": [{ "text": sys }]
                    }
                })
            } else {
                serde_json::json!({
                    "contents": contents
                })
            };
            if !gen_config.is_empty() {
                g_body["generationConfig"] = serde_json::Value::Object(gen_config);
            }
            // Native function calling: convert OpenAI-format tools to Gemini
            // functionDeclarations so the model returns structured functionCall
            // parts instead of free-form JSON text.
            if let Some(tools) = tools {
                if let Some(decls) = openai_tools_to_gemini(tools) {
                    g_body["tools"] = serde_json::json!([{ "functionDeclarations": decls }]);
                    g_body["toolConfig"] = serde_json::json!({
                        "functionCallingConfig": { "mode": "AUTO" }
                    });
                }
            }
            g_body
        }
        _ => unreachable!(),
    }
}
