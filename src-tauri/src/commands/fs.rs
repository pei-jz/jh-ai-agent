use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct CustomDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

// ── Encoding detection ────────────────────────────────────────────────────────

/// Detects the charset of `bytes` by checking BOM first, then UTF-8 validity,
/// then a simple Shift-JIS / EUC-JP heuristic for Japanese content.
/// Returns (encoding_rs::Encoding, bom_byte_count).
fn detect_encoding(bytes: &[u8]) -> (&'static encoding_rs::Encoding, usize) {
    use encoding_rs::*;
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return (UTF_8, 3);
    }
    if bytes.starts_with(b"\xFF\xFE") {
        return (UTF_16LE, 2);
    }
    if bytes.starts_with(b"\xFE\xFF") {
        return (UTF_16BE, 2);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return (UTF_8, 0);
    }
    // Heuristic: count valid Shift-JIS vs EUC-JP two-byte sequences.
    let mut sjis = 0u32;
    let mut euc = 0u32;
    let mut i = 0;
    while i + 1 < bytes.len() {
        let (b1, b2) = (bytes[i], bytes[i + 1]);
        if ((b1 >= 0x81 && b1 <= 0x9F) || (b1 >= 0xE0 && b1 <= 0xFC))
            && ((b2 >= 0x40 && b2 <= 0x7E) || (b2 >= 0x80 && b2 <= 0xFC))
        {
            sjis += 1;
            i += 2;
            continue;
        }
        if b1 >= 0xA1 && b1 <= 0xFE && b2 >= 0xA1 && b2 <= 0xFE {
            euc += 1;
            i += 2;
            continue;
        }
        i += 1;
    }
    if euc > sjis {
        (encoding_rs::EUC_JP, 0)
    } else {
        (encoding_rs::SHIFT_JIS, 0)
    }
}

/// Decodes `bytes` (after stripping `bom_len` leading bytes) using `enc`.
fn decode_bytes(bytes: &[u8], enc: &'static encoding_rs::Encoding, bom_len: usize) -> String {
    let data = &bytes[bom_len..];
    let (cow, _, _) = enc.decode(data);
    cow.into_owned()
}

/// Returns the encoding_rs Encoding for a user-supplied label string.
fn encoding_for_label(label: &str) -> &'static encoding_rs::Encoding {
    encoding_rs::Encoding::for_label(label.as_bytes())
        .unwrap_or(encoding_rs::UTF_8)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Read a file and return its contents as a UTF-8 string, transparently
/// decoding Shift-JIS / EUC-JP / UTF-16 files so the LLM always receives text.
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (enc, bom_len) = detect_encoding(&bytes);
    Ok(decode_bytes(&bytes, enc, bom_len))
}

/// Write `content` (UTF-8 string from the LLM) to `path`.
///
/// Encoding resolution order:
/// 1. If `encoding` is given, use that charset.
/// 2. If the file already exists, detect its charset and match it (including BOM).
/// 3. Otherwise write as UTF-8 without BOM.
#[tauri::command]
pub async fn write_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    use encoding_rs::*;
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    // Determine target encoding and whether to include a BOM.
    let (target_enc, write_bom): (&'static Encoding, bool) = if let Some(ref label) = encoding {
        let enc = encoding_for_label(label.trim());
        // Only write BOM when the caller explicitly requests it.
        let bom = label.trim().to_lowercase().contains("bom");
        (enc, bom)
    } else if p.exists() {
        // Match the existing file's encoding (including BOM presence).
        let existing = fs::read(&path).unwrap_or_default();
        let (enc, bom_len) = detect_encoding(&existing);
        (enc, bom_len > 0)
    } else {
        (UTF_8, false)
    };

    // Encode content string → bytes.
    let body: Vec<u8> = if target_enc == UTF_8 {
        content.into_bytes()
    } else {
        let (encoded, _, _) = target_enc.encode(&content);
        encoded.into_owned()
    };

    // Prepend BOM if required.
    let bytes_to_write: Vec<u8> = if write_bom {
        let bom: &[u8] = if target_enc == UTF_8 {
            b"\xEF\xBB\xBF"
        } else if target_enc == UTF_16LE {
            b"\xFF\xFE"
        } else if target_enc == UTF_16BE {
            b"\xFE\xFF"
        } else {
            b""
        };
        let mut v = bom.to_vec();
        v.extend_from_slice(&body);
        v
    } else {
        body
    };

    fs::write(p, bytes_to_write).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_dir(path: String) -> Result<Vec<CustomDirEntry>, String> {
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    
    for entry in entries {
        if let Ok(entry) = entry {
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            list.push(CustomDirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            });
        }
    }
    
    Ok(list)
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        Ok(()) // already gone — treat as success
    }
}

#[tauri::command]
pub async fn file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<serde_json::Value, String> {
    let path_obj = std::path::Path::new(&path);
    let name = path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path_obj
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let size = bytes.len();

    if size > 10 * 1024 * 1024 {
        return Err("File exceeds 10 MB limit".to_string());
    }

    Ok(serde_json::json!({
        "name": name,
        "ext":  ext,
        "size": size,
        "bytes": bytes
    }))
}

#[tauri::command]
pub async fn select_folder() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .pick_folder();
    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn parse_excel_to_html(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    use calamine::{Xlsx, Xls, Ods, open_workbook_from_rs};
    use std::io::Cursor;

    let cursor = Cursor::new(bytes);
    let ext_lower = ext.to_lowercase();

    if ext_lower == "xlsx" {
        let mut workbook = open_workbook_from_rs::<Xlsx<_>, _>(cursor)
            .map_err(|e| format!("Failed to open XLSX workbook: {}", e))?;
        process_workbook_html(&mut workbook)
    } else if ext_lower == "xls" {
        let mut workbook = open_workbook_from_rs::<Xls<_>, _>(cursor)
            .map_err(|e| format!("Failed to open XLS workbook: {}", e))?;
        process_workbook_html(&mut workbook)
    } else if ext_lower == "ods" {
        let mut workbook = open_workbook_from_rs::<Ods<_>, _>(cursor)
            .map_err(|e| format!("Failed to open ODS workbook: {}", e))?;
        process_workbook_html(&mut workbook)
    } else {
        Err(format!("Unsupported Excel extension: {}", ext))
    }
}

fn process_workbook_html<R, RS>(workbook: &mut R) -> Result<String, String>
where
    R: calamine::Reader<RS>,
    RS: std::io::Read + std::io::Seek,
{
    let mut output = String::from("<html><body>\n");
    let sheet_names = workbook.sheet_names().to_vec();

    for sheet_name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(sheet_name) {
            output.push_str(&format!(
                "<h3>{}</h3>\n",
                html_escape(sheet_name)
            ));

            let rows: Vec<_> = range.rows().collect();
            if rows.is_empty() {
                output.push_str("<p><em>Empty sheet</em></p>\n");
                continue;
            }

            output.push_str("<table border=\"1\" cellspacing=\"0\">\n<thead>\n<tr>\n");
            for cell in rows[0].iter() {
                output.push_str(&format!("<th>{}</th>", format_cell_html(cell)));
            }
            output.push_str("\n</tr>\n</thead>\n<tbody>\n");

            for row in rows.iter().skip(1) {
                output.push_str("<tr>\n");
                for cell in row.iter() {
                    output.push_str(&format!("<td>{}</td>", format_cell_html(cell)));
                }
                output.push_str("\n</tr>\n");
            }

            output.push_str("</tbody>\n</table>\n\n");
        }
    }

    output.push_str("</body></html>");
    Ok(output)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn format_cell_html(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => "".to_string(),
        calamine::Data::String(s) => html_escape(s).replace('\n', "<br>"),
        calamine::Data::Float(f) => format_float(*f),
        calamine::Data::Int(i) => i.to_string(),
        calamine::Data::Bool(b) => (if *b { "TRUE" } else { "FALSE" }).to_string(),
        calamine::Data::DateTime(dt) => excel_datetime_to_string(dt),
        calamine::Data::DateTimeIso(s) => html_escape(s),
        calamine::Data::DurationIso(s) => html_escape(s),
        calamine::Data::Error(err) => format!("<em>Error: {:?}</em>", err),
    }
}

fn format_float(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        // 余分な末尾ゼロを除去
        let s = format!("{:.10}", f);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn excel_datetime_to_string(dt: &calamine::ExcelDateTime) -> String {
    use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};

    let serial = dt.as_f64();

    // Excel 1900年うるう年バグ対応: シリアル値60未満は +1 補正
    let adjusted = if serial >= 60.0 { serial } else { serial + 1.0 };

    let epoch = NaiveDateTime::new(
        NaiveDate::from_ymd_opt(1899, 12, 30).unwrap(),
        NaiveTime::MIN,
    );

    let ms = (adjusted * 86_400_000.0).round() as i64;
    match epoch.checked_add_signed(Duration::milliseconds(ms)) {
        Some(naive_dt) => {
            if serial < 1.0 {
                // 時刻のみ（duration）
                naive_dt.format("%H:%M:%S").to_string()
            } else if naive_dt.time() == NaiveTime::MIN {
                naive_dt.format("%Y-%m-%d").to_string()
            } else {
                naive_dt.format("%Y-%m-%d %H:%M:%S").to_string()
            }
        }
        None => format!("{}", serial),
    }
}
