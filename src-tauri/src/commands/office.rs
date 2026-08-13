// office.rs — let the agent read and write Office documents.
//
// Real projects keep their specifications, data and decisions in .xlsx / .docx /
// .pptx. `read_file` returns text, so pointing it at one of those yields binary
// garbage — the agent simply could not see that material. These commands turn a
// document into something a model can actually reason about (Markdown), and let
// it produce a spreadsheet as a deliverable.
//
// Reading:
//   xlsx / xlsm / xls / ods  → calamine, emitted as Markdown tables per sheet
//   docx                     → OOXML zip → word/document.xml → paragraph text
//   pptx                     → OOXML zip → ppt/slides/slideN.xml → per-slide text
//
// Reading also reports, for a spreadsheet:
//   • A1-style CELL ADDRESSES, so the model can name where to write. A Markdown
//     table alone gave it no way to say "D14", which made update_xlsx unusable.
//   • MERGED RANGES. A merged title spanning four columns arrives as one value and
//     three blanks; without knowing it was merged the model reads three missing
//     fields. This matters most for the Japanese business spreadsheets that use
//     merges structurally.
//
// Writing:
//   xlsx (new)               → rust_xlsxwriter (pure Rust; no C toolchain)
//   xlsx (edit in place)     → umya-spreadsheet, which round-trips the file so
//                              formulas, formats and untouched sheets survive
//   docx                     → OOXML written directly with the zip writer
//
// Not implemented: writing pptx. A deck is a layout problem (EMU geometry, theme
// references, per-slide relationship parts) rather than a document one, and an HTML
// deck the agent can actually SEE and correct is a better answer than a fragile
// pptx it cannot. Say so rather than emitting a broken file.

use serde::Serialize;
use std::io::{Cursor, Read};
use crate::path_guard::PathGuard;
use tauri::State;

/// Cap on how much text one document may contribute, so a 50-sheet workbook
/// can't blow the context window. The caller sees an explicit truncation note.
const DEFAULT_MAX_CHARS: usize = 60_000;

/// Ceilings on image extraction. Vision input is billed per image and a deck can
/// carry hundreds, so this is opt-in AND capped — a diagram or two is what makes
/// a document understandable, not every bullet icon.
const MAX_IMAGES: usize = 6;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
/// Below this an image is almost certainly a bullet, logo or rule — never the
/// diagram the model needs.
const MIN_IMAGE_BYTES: usize = 8 * 1024;

#[derive(serde::Serialize, Debug)]
pub struct OfficeImage {
    /// Entry name inside the package, e.g. "ppt/media/image3.png".
    pub name: String,
    pub mime: String,
    /// Base64 (no data: prefix — the frontend builds the data URL).
    pub data: String,
}

#[derive(serde::Serialize, Debug)]
pub struct OfficeDoc {
    /// Markdown rendering of the document.
    pub text: String,
    /// "xlsx" | "docx" | "pptx" | …
    pub kind: String,
    /// Sheet names / slide count / paragraph count, for a one-line summary.
    pub parts: Vec<String>,
    pub truncated: bool,
    /// Embedded images, when the caller asked for them.
    pub images: Vec<OfficeImage>,
}

/// Vision-capable formats. EMF/WMF are vector formats no LLM accepts, so they are
/// skipped rather than sent and rejected.
fn image_mime(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") { Some("image/png") }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { Some("image/jpeg") }
    else if lower.ends_with(".gif") { Some("image/gif") }
    else if lower.ends_with(".webp") { Some("image/webp") }
    else { None }
}

/// Pull embedded images out of an OOXML/ODF package.
///
/// All four formats are zip packages that keep their media in one directory, so
/// one pass covers xlsx/docx/pptx/ods. Largest first: in a real document the big
/// entry is the diagram and the small ones are decoration, and the cap means the
/// ones that survive should be the informative ones.
fn extract_images(bytes: &[u8]) -> Vec<OfficeImage> {
    use base64::Engine;

    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(bytes)) else { return Vec::new() };

    let mut candidates: Vec<(u64, String, &'static str)> = Vec::new();
    for i in 0..zip.len() {
        let Ok(f) = zip.by_index(i) else { continue };
        let name = f.name().to_string();
        let in_media = name.starts_with("xl/media/")
            || name.starts_with("word/media/")
            || name.starts_with("ppt/media/")
            || name.starts_with("Pictures/");          // ODF
        if !in_media { continue; }
        let Some(mime) = image_mime(&name) else { continue };
        let size = f.size();
        if size < MIN_IMAGE_BYTES as u64 || size > MAX_IMAGE_BYTES as u64 { continue; }
        candidates.push((size, name, mime));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.truncate(MAX_IMAGES);
    // Restore document order so the model sees them as they appear.
    candidates.sort_by(|a, b| a.1.cmp(&b.1));

    let mut out = Vec::new();
    for (_, name, mime) in candidates {
        let Ok(mut f) = zip.by_name(&name) else { continue };
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() { continue; }
        out.push(OfficeImage {
            name,
            mime: mime.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(&buf),
        });
    }
    out
}

/// Escape pipes so cell content can't break the Markdown table it sits in.
fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ").trim().to_string()
}

/// One cell as the text the model sees.
///
/// Dates are the reason this exists. Excel stores them as a serial number and
/// calamine's Display prints that number, so a schedule column arrived as
/// "46231" — unreadable, and worse, silently plausible as a quantity. Render the
/// real date instead (calamine's conversion handles the 1900 leap-year quirk).
/// Time-only cells keep just the time; whole days drop the 00:00:00.
fn cell_text(cell: &calamine::Data) -> String {
    // calamine 0.25 renamed the enum to `Data`; `DataType` is now the trait that
    // carries as_datetime() — both are needed here.
    use calamine::{Data, DataType};
    match cell {
        Data::DateTime(_) => match cell.as_datetime() {
            Some(dt) => {
                if dt.time() == chrono::NaiveTime::MIN {
                    dt.date().format("%Y-%m-%d").to_string()
                } else if dt.date() == chrono::NaiveDate::from_ymd_opt(1899, 12, 31).unwrap() {
                    // Serial < 1 is a clock time with no meaningful date part.
                    dt.time().format("%H:%M:%S").to_string()
                } else {
                    dt.format("%Y-%m-%d %H:%M:%S").to_string()
                }
            }
            // Outside chrono's range — the raw serial beats losing the cell.
            None => cell.to_string(),
        },
        other => other.to_string(),
    }
}

/// Read a whole entry out of a zip package as UTF-8 text.
fn zip_entry_text(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// Pull the visible text out of an OOXML part.
///
/// `<w:t>` (Word) and `<a:t>` (DrawingML, used by PowerPoint) hold the runs of
/// literal text. Paragraph boundaries (`w:p` / `a:p`) become newlines so the
/// output keeps its shape instead of collapsing into one line.
fn ooxml_text(xml: &str, text_tag: &str, para_tag: &str) -> String {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut out = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == text_tag { in_text = true; }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == text_tag { in_text = false; }
                if name == para_tag { out.push('\n'); }
            }
            Ok(Event::Text(e)) => {
                if in_text {
                    out.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Column index → spreadsheet letter. 0→A, 25→Z, 26→AA.
///
/// The model cannot ask for "the cell next to the total" — it has to say `D14`. A
/// Markdown table alone gave it no way to name a cell, which is why update_xlsx
/// would otherwise be unusable: the agent could read a sheet and still not be able
/// to say where to write.
pub fn col_letter(mut idx: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (idx % 26) as u8);
        if idx < 26 { break; }
        idx = idx / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The merged ranges of one worksheet, as `A1:C1` strings.
///
/// calamine does not expose these, so the sheet XML is read directly. They matter
/// for the shape of Japanese business spreadsheets in particular: a merged title
/// spanning four columns arrives as one value followed by three blanks, and without
/// knowing it was merged the model reads that as three missing fields.
fn merged_ranges(bytes: &[u8], sheet_index: usize) -> Vec<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(bytes.to_vec())) else { return Vec::new() };
    // Sheets are xl/worksheets/sheetN.xml, 1-based and in workbook order.
    let name = format!("xl/worksheets/sheet{}.xml", sheet_index + 1);
    let Some(xml) = zip_entry_text(&mut zip, &name) else { return Vec::new() };

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut out = Vec::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            // <mergeCell ref="A1:C1"/> is normally empty, but tolerate both forms.
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if e.name().as_ref() == b"mergeCell" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"ref" {
                            out.push(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Spreadsheet → one Markdown table per sheet.
fn read_spreadsheet(bytes: Vec<u8>, ext: &str, max_chars: usize, sheet: Option<&str>) -> Result<OfficeDoc, String> {
    use calamine::{open_workbook_from_rs, Ods, Xls, Xlsx};

    // Merged ranges come from the sheet XML, so only the zip-packaged formats have
    // them. .xls is a legacy binary and .ods stores them differently; both simply
    // report none rather than guessing.
    let zip_bytes = if matches!(ext, "xlsx" | "xlsm") { Some(bytes.clone()) } else { None };
    let cursor = Cursor::new(bytes);
    // Each branch produces (markdown, sheet names).
    let (text, parts) = match ext {
        "xlsx" | "xlsm" => {
            let wb = open_workbook_from_rs::<Xlsx<_>, _>(cursor)
                .map_err(|e| format!("Failed to open workbook: {}", e))?;
            sheets_to_markdown(wb, max_chars, sheet, zip_bytes.as_deref())?
        }
        "xls" => {
            let wb = open_workbook_from_rs::<Xls<_>, _>(cursor)
                .map_err(|e| format!("Failed to open workbook: {}", e))?;
            sheets_to_markdown(wb, max_chars, sheet, None)?
        }
        "ods" => {
            let wb = open_workbook_from_rs::<Ods<_>, _>(cursor)
                .map_err(|e| format!("Failed to open workbook: {}", e))?;
            sheets_to_markdown(wb, max_chars, sheet, None)?
        }
        _ => return Err(format!("Unsupported spreadsheet extension: {}", ext)),
    };

    let truncated = text.len() >= max_chars;
    Ok(OfficeDoc { text, kind: ext.to_string(), parts, truncated, images: Vec::new() })
}

/// Render one sheet as a Markdown table. Returns false if the budget ran out
/// part-way, so the caller can say which sheets are missing.
///
/// The first column of the table is the ROW NUMBER and the header row carries column
/// LETTERS, so every value in the output has an address the model can name. Without
/// that, an agent could read a sheet perfectly and still be unable to say where to
/// write — which is what made update_xlsx worth having.
fn sheet_to_markdown(
    range: &calamine::Range<calamine::Data>,
    name: &str,
    out: &mut String,
    max_chars: usize,
    merges: &[String],
) -> bool {
    let (rows, cols) = range.get_size();
    out.push_str(&format!("\n## Sheet: {} ({} rows × {} cols)\n\n", name, rows, cols));
    if rows == 0 {
        out.push_str("(empty)\n");
        return true;
    }

    // Where the used range starts, so the printed addresses are the REAL ones. A
    // sheet whose data begins at C5 would otherwise be labelled from A1.
    let start = range.start().unwrap_or((0, 0));
    let (row0, col0) = (start.0 as usize, start.1 as usize);

    if !merges.is_empty() {
        // Named up front: the blanks beside a merged value are not missing data, and
        // a model that does not know that will try to "fix" them.
        out.push_str(&format!(
            "Merged ranges (one value spans the whole range; the other cells are empty by design): {}\n\n",
            merges.join(", ")
        ));
    }

    // Header: the column letters.
    let letters: Vec<String> = (0..cols).map(|c| col_letter(col0 + c)).collect();
    out.push_str(&format!("| | {} |\n", letters.join(" | ")));
    out.push_str(&format!("| --- |{}|\n", letters.iter().map(|_| " --- ").collect::<Vec<_>>().join("|")));

    for (r, row) in range.rows().enumerate() {
        if out.len() >= max_chars { return false; }
        let cells: Vec<String> = row.iter().map(|c| md_cell(&cell_text(c))).collect();
        // A fully blank row carries no information for the model.
        if cells.iter().all(|c| c.is_empty()) { continue; }
        out.push_str(&format!("| **{}** | {} |\n", row0 + r + 1, cells.join(" | ")));
    }
    true
}

/// Workbook → Markdown.
///
/// The index comes FIRST and always. A 40-sheet workbook can't fit in a context
/// window, and a silently truncated dump leaves the model believing it has seen
/// the whole file — so it gets the map up front, and an explicit list of what was
/// left out, with the parameter needed to fetch it.
///
/// `want` selects a single sheet (case-insensitive); unknown names are an error
/// listing the real ones rather than an empty result.
fn sheets_to_markdown<R, RS>(mut wb: R, max_chars: usize, want: Option<&str>, zip_bytes: Option<&[u8]>) -> Result<(String, Vec<String>), String>
where
    R: calamine::Reader<RS>,
    RS: std::io::Read + std::io::Seek,
    // Needed to report WHY a sheet could not be read instead of dropping it.
    <R as calamine::Reader<RS>>::Error: std::fmt::Display,
{
    let names = wb.sheet_names().to_vec();

    if let Some(want) = want {
        let hit = names.iter().find(|n| n.eq_ignore_ascii_case(want)).cloned();
        let Some(name) = hit else {
            return Err(format!(
                "No sheet named \"{}\". Available sheets: {}",
                want,
                names.join(", ")
            ));
        };
        let range = wb.worksheet_range(&name)
            .map_err(|e| format!("Failed to read sheet \"{}\": {}", name, e))?;
        let mut out = String::new();
        let idx = names.iter().position(|n| n == &name).unwrap_or(0);
        let merges = zip_bytes.map(|b| merged_ranges(b, idx)).unwrap_or_default();
        sheet_to_markdown(&range, &name, &mut out, max_chars, &merges);
        return Ok((out, names));
    }

    // Index first: name + dimensions for every sheet, so one read is enough to
    // decide where to look next.
    let mut index = String::from("# Workbook index\n\n| # | Sheet | Rows | Cols |\n| --- | --- | --- | --- |\n");
    let mut ranges = Vec::new();
    for (i, name) in names.iter().enumerate() {
        match wb.worksheet_range(name) {
            Ok(r) => {
                let (rows, cols) = r.get_size();
                index.push_str(&format!("| {} | {} | {} | {} |\n", i + 1, name, rows, cols));
                ranges.push((name.clone(), r));
            }
            Err(e) => {
                index.push_str(&format!("| {} | {} | (unreadable: {}) | |\n", i + 1, name, e));
            }
        }
    }

    let mut body = String::new();
    let mut rendered = 0usize;
    let budget = max_chars.saturating_sub(index.len());
    for (name, range) in &ranges {
        if body.len() >= budget { break; }
        let idx = names.iter().position(|n| n == name).unwrap_or(0);
        let merges = zip_bytes.map(|b| merged_ranges(b, idx)).unwrap_or_default();
        if !sheet_to_markdown(range, name, &mut body, budget, &merges) { break; }
        rendered += 1;
    }

    let mut out = index;
    out.push('\n');
    out.push_str(&body);
    if rendered < ranges.len() {
        let missing: Vec<&str> = ranges[rendered..].iter().map(|(n, _)| n.as_str()).collect();
        out.push_str(&format!(
            "\n[!] Stopped after {} of {} sheets — the rest did not fit. NOT shown: {}. \
             Call read_office again with sheet=\"<name>\" to read one of them in full.\n",
            rendered, ranges.len(), missing.join(", ")
        ));
    }
    Ok((out, names))
}

/// .docx → paragraph text.
fn read_docx(bytes: Vec<u8>, max_chars: usize) -> Result<OfficeDoc, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Not a valid .docx package: {}", e))?;
    let xml = zip_entry_text(&mut zip, "word/document.xml")
        .ok_or("word/document.xml not found — is this really a .docx?")?;

    let raw = ooxml_text(&xml, "w:t", "w:p");
    // Collapse the runs of blank lines OOXML produces.
    let mut paras: Vec<String> = raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let count = paras.len();

    let mut text = String::new();
    for p in paras.drain(..) {
        if text.len() >= max_chars { break; }
        text.push_str(&p);
        text.push_str("\n\n");
    }
    let truncated = text.len() >= max_chars;
    Ok(OfficeDoc {
        text,
        kind: "docx".into(),
        parts: vec![format!("{} paragraphs", count)],
        truncated,
        images: Vec::new(),
    })
}

/// .pptx → one section per slide.
fn read_pptx(bytes: Vec<u8>, max_chars: usize) -> Result<OfficeDoc, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Not a valid .pptx package: {}", e))?;

    // Slide parts are ppt/slides/slide1.xml, slide2.xml, … — sort NUMERICALLY so
    // slide10 doesn't land between slide1 and slide2.
    let mut slides: Vec<(usize, String)> = zip
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .map(|n| {
            let num = n.trim_start_matches("ppt/slides/slide")
                .trim_end_matches(".xml")
                .parse::<usize>()
                .unwrap_or(usize::MAX);
            (num, n.to_string())
        })
        .collect();
    slides.sort_by_key(|(n, _)| *n);

    if slides.is_empty() {
        return Err("No slides found — is this really a .pptx?".into());
    }

    let total = slides.len();
    let mut text = String::new();
    for (num, name) in slides {
        if text.len() >= max_chars { break; }
        let Some(xml) = zip_entry_text(&mut zip, &name) else { continue };
        let body = ooxml_text(&xml, "a:t", "a:p");
        text.push_str(&format!("\n## Slide {}\n\n", num));
        for line in body.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
            text.push_str(&format!("- {}\n", line));
        }
    }
    let truncated = text.len() >= max_chars;
    Ok(OfficeDoc {
        text,
        kind: "pptx".into(),
        parts: vec![format!("{} slides", total)],
        truncated,
        images: Vec::new(),
    })
}

/// Read an Office document as Markdown the model can reason about.
#[tauri::command]
pub async fn read_office_document(
    path: String,
    max_chars: Option<usize>,
    sheet: Option<String>,
    include_images: Option<bool>,
    guard: State<'_, PathGuard>,
) -> Result<OfficeDoc, String> {
    guard.ensure_allowed(&path)?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("File exceeds the 50 MB limit".into());
    }
    let cap = max_chars.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_CHARS);
    let want_sheet = sheet.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let is_spreadsheet = matches!(ext.as_str(), "xlsx" | "xlsm" | "xls" | "ods");
    if want_sheet.is_some() && !is_spreadsheet {
        return Err(format!("`sheet` only applies to spreadsheets, not .{}", ext));
    }

    // Images come from the package, independent of how the text is parsed. .xls is
    // a legacy binary (not a zip), so it has none to give.
    let images = if include_images.unwrap_or(false) && ext != "xls" {
        extract_images(&bytes)
    } else {
        Vec::new()
    };

    let mut doc = match ext.as_str() {
        "xlsx" | "xlsm" | "xls" | "ods" => read_spreadsheet(bytes, &ext, cap, want_sheet),
        "docx" => read_docx(bytes, cap),
        "pptx" => read_pptx(bytes, cap),
        "doc" | "ppt" => Err(format!(
            "Legacy binary .{} is not supported — save it as .{}x and retry.",
            ext, ext
        )),
        other => Err(format!("Not an Office document: .{}", other)),
    }?;
    doc.images = images;
    Ok(doc)
}

/// One sheet of a workbook to be written.
#[derive(serde::Deserialize)]
pub struct SheetSpec {
    pub name: Option<String>,
    /// Row-major cells. The first row is styled as a header.
    pub rows: Vec<Vec<serde_json::Value>>,
}

/// Write an .xlsx workbook. Numbers stay numeric so Excel can compute on them.
#[tauri::command]
pub async fn write_xlsx(
    path: String,
    sheets: Vec<SheetSpec>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    use rust_xlsxwriter::{Format, Workbook};

    guard.ensure_allowed(&path)?;
    if sheets.is_empty() {
        return Err("write_xlsx requires at least one sheet".into());
    }

    let mut book = Workbook::new();
    let header = Format::new().set_bold();

    for (i, spec) in sheets.iter().enumerate() {
        let sheet = book.add_worksheet();
        if let Some(name) = spec.name.as_deref().filter(|n| !n.is_empty()) {
            // Excel rejects >31 chars and a few characters outright; fall back to
            // the default name rather than failing the whole write.
            let safe: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
            let _ = sheet.set_name(&safe);
        }
        for (r, row) in spec.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let (row_i, col_i) = (r as u32, c as u16);
                let fmt = if r == 0 { Some(&header) } else { None };
                // write_* returns &mut Worksheet; map to () so the borrow ends
                // here instead of being moved into `res`.
                let res: Result<(), rust_xlsxwriter::XlsxError> = match cell {
                    serde_json::Value::Number(n) => {
                        let v = n.as_f64().unwrap_or(0.0);
                        match fmt {
                            Some(f) => sheet.write_number_with_format(row_i, col_i, v, f).map(|_| ()),
                            None => sheet.write_number(row_i, col_i, v).map(|_| ()),
                        }
                    }
                    serde_json::Value::Bool(b) => match fmt {
                        Some(f) => sheet.write_boolean_with_format(row_i, col_i, *b, f).map(|_| ()),
                        None => sheet.write_boolean(row_i, col_i, *b).map(|_| ()),
                    },
                    serde_json::Value::Null => Ok(()),
                    other => {
                        let s = other.as_str().map(str::to_string)
                            .unwrap_or_else(|| other.to_string());
                        match fmt {
                            Some(f) => sheet.write_string_with_format(row_i, col_i, &s, f).map(|_| ()),
                            None => sheet.write_string(row_i, col_i, &s).map(|_| ()),
                        }
                    }
                };
                res.map_err(|e| format!("sheet {} cell ({},{}): {}", i, r, c, e))?;
            }
        }
    }

    book.save(&path).map_err(|e| format!("Failed to write {}: {}", path, e))?;
    let sheet_count = sheets.len();
    let row_count: usize = sheets.iter().map(|s| s.rows.len()).sum();
    Ok(format!("Wrote {} ({} sheet(s), {} rows)", path, sheet_count, row_count))
}

// ── Writing a .docx ──────────────────────────────────────────────────────────
//
// A .docx is a zip with a handful of XML parts. Only the minimum set Word actually
// requires is written — [Content_Types].xml, the two relationship parts, and
// document.xml — because every part beyond that is another thing to get subtly
// wrong, and Word supplies its own defaults for the rest.
//
// The input is light Markdown rather than a paragraph model: "# Heading", "- item",
// "1. item", blank-line-separated paragraphs, plus **bold** and *italic* inline.
// That is what an LLM produces naturally, so the alternative would be asking it to
// serialise a structure it has no reason to hold.

/// XML-escape. Word rejects the whole document on a stray `&`, so this is not
/// cosmetic — it is the difference between a file that opens and one that does not.
fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// One paragraph's inline runs, honouring **bold** and *italic*.
///
/// Deliberately simple: a single pass, no nesting. A malformed marker degrades to
/// literal text rather than corrupting the run structure.
fn docx_runs(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        // Longest marker first, or "**bold**" would match the italic rule.
        let bold = rest.find("**").and_then(|i| rest[i + 2..].find("**").map(|j| (i, i + 2 + j)));
        let ital = rest.find('*').and_then(|i| {
            if rest[i..].starts_with("**") { return None; }
            rest[i + 1..].find('*').map(|j| (i, i + 1 + j))
        });

        let pick = match (bold, ital) {
            (Some(b), Some(it)) => if b.0 <= it.0 { Some((b, true)) } else { Some((it, false)) },
            (Some(b), None) => Some((b, true)),
            (None, Some(it)) => Some((it, false)),
            (None, None) => None,
        };

        match pick {
            Some(((start, end), is_bold)) => {
                let mark = if is_bold { 2 } else { 1 };
                if start > 0 {
                    out.push_str(&format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_esc(&rest[..start])));
                }
                let inner = &rest[start + mark..end];
                let prop = if is_bold { "<w:b/>" } else { "<w:i/>" };
                out.push_str(&format!(
                    "<w:r><w:rPr>{}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                    prop, xml_esc(inner)
                ));
                rest = &rest[end + mark..];
            }
            None => {
                out.push_str(&format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_esc(rest)));
                break;
            }
        }
    }
    if out.is_empty() {
        out.push_str("<w:r><w:t xml:space=\"preserve\"></w:t></w:r>");
    }
    out
}

/// Light Markdown → the body of word/document.xml.
fn docx_body(markdown: &str) -> String {
    let mut body = String::new();
    for raw in markdown.replace("\r\n", "\n").split('\n') {
        let line = raw.trim_end();
        let trimmed = line.trim_start();

        if trimmed.is_empty() {
            // An empty paragraph IS the blank line — dropping it runs the text
            // together, which is the most common complaint about generated docs.
            body.push_str("<w:p/>");
            continue;
        }

        // Heading: leading #s, capped at Word's Heading1..6 styles.
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if hashes > 0 && hashes <= 6 && trimmed.chars().nth(hashes) == Some(' ') {
            let text = trimmed[hashes + 1..].trim();
            body.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"Heading{}\"/></w:pPr>{}</w:p>",
                hashes, docx_runs(text)
            ));
            continue;
        }

        // Bullet / numbered item. Word needs a numbering definition for real list
        // formatting; the ListParagraph style plus the marker keeps it readable
        // without shipping a numbering.xml whose ids we would have to manage.
        let bullet = trimmed.starts_with("- ") || trimmed.starts_with("* ");
        let numbered = trimmed
            .find(". ")
            .map(|i| i > 0 && trimmed[..i].chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if bullet || numbered {
            let text = if bullet {
                format!("• {}", &trimmed[2..])
            } else {
                trimmed.to_string()
            };
            body.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/><w:ind w:left=\"360\"/></w:pPr>{}</w:p>",
                docx_runs(&text)
            ));
            continue;
        }

        body.push_str(&format!("<w:p>{}</w:p>", docx_runs(trimmed)));
    }
    body
}

/// Write a .docx from light Markdown.
///
/// "The agent can deliver prose as Markdown instead" was the previous answer, and it
/// is not one: in the environments this product targets, the deliverable IS a Word
/// file. A report the user has to convert by hand is not a report.
#[tauri::command]
pub async fn write_docx(
    path: String,
    markdown: String,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    guard.ensure_allowed(&path)?;
    if markdown.trim().is_empty() {
        return Err("write_docx requires non-empty `markdown` content".into());
    }

    let body = docx_body(&markdown);
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>"#,
        body
    );

    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;

    const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", ROOT_RELS),
            ("word/document.xml", document.as_str()),
        ] {
            zw.start_file(name, opts).map_err(|e| format!("zip {}: {}", name, e))?;
            zw.write_all(content.as_bytes()).map_err(|e| format!("write {}: {}", name, e))?;
        }
        zw.finish().map_err(|e| format!("Failed to finalise the .docx: {}", e))?;
    }

    std::fs::write(&path, &buf).map_err(|e| format!("Failed to write {}: {}", path, e))?;
    let paras = body.matches("<w:p").count();
    Ok(format!("Wrote {} ({} paragraphs)", path, paras))
}

// ── Editing an existing .xlsx ────────────────────────────────────────────────

/// One cell to change: an A1 address and the value to put there.
#[derive(serde::Deserialize)]
pub struct CellEdit {
    /// Sheet name. Omitted = the first sheet.
    pub sheet: Option<String>,
    /// A1-style address, e.g. "D14".
    pub cell: String,
    pub value: serde_json::Value,
}

/// Apply cell edits to an EXISTING workbook, in place.
///
/// This is a different job from write_xlsx, not a variant of it. rust_xlsxwriter
/// cannot read a file, so "read it and write it back" would silently discard every
/// formula, every format and every sheet the agent did not touch — for the ledgers and
/// forms this is aimed at, that is data loss dressed up as an edit. umya-spreadsheet
/// round-trips the package, so untouched content survives byte-for-byte where it can.
///
/// Numbers stay numeric so Excel keeps computing on them; a string starting with `=`
/// is written as a FORMULA, because that is unambiguously what it means in a cell.
#[tauri::command]
pub async fn update_xlsx(
    path: String,
    edits: Vec<CellEdit>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    guard.ensure_allowed(&path)?;
    if edits.is_empty() {
        return Err("update_xlsx requires at least one edit".into());
    }
    let file = std::path::Path::new(&path);
    if !file.exists() {
        return Err(format!(
            "{} does not exist. update_xlsx EDITS an existing workbook; use write_xlsx to create one.",
            path
        ));
    }

    let mut book = umya_spreadsheet::reader::xlsx::read(file)
        .map_err(|e| format!("Failed to open {}: {:?}", path, e))?;

    // Collected BEFORE any mutable borrow, so a bad sheet name can still be reported
    // alongside the real ones — a bare "not found" costs the agent another blind
    // round-trip.
    let sheet_names: Vec<String> = book
        .sheet_collection()
        .iter()
        .map(|s| s.name().to_string())
        .collect();
    let first_sheet = sheet_names.first().cloned().ok_or("The workbook has no sheets")?;

    let mut applied = 0usize;
    for (i, edit) in edits.iter().enumerate() {
        let sheet_name = edit.sheet.clone().unwrap_or_else(|| first_sheet.clone());
        let addr = edit.cell.trim().to_uppercase();
        if addr.is_empty() {
            return Err(format!("edit {}: `cell` is required (an A1 address such as D14)", i));
        }

        if !sheet_names.contains(&sheet_name) {
            return Err(format!(
                "edit {}: no sheet named \"{}\". Available sheets: {}",
                i, sheet_name, sheet_names.join(", ")
            ));
        }
        // umya returns a Result here, not an Option.
        let sheet = book
            .sheet_by_name_mut(&sheet_name)
            .map_err(|e| format!("edit {}: could not open sheet \"{}\": {:?}", i, sheet_name, e))?;

        let cell = sheet.cell_mut(&*addr);
        match &edit.value {
            serde_json::Value::Number(n) => {
                cell.set_value_number(n.as_f64().unwrap_or(0.0));
            }
            serde_json::Value::Bool(b) => {
                cell.set_value_bool(*b);
            }
            // Null CLEARS the cell rather than writing the text "null".
            serde_json::Value::Null => {
                cell.set_value("");
            }
            other => {
                let text = other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string());
                if let Some(f) = text.strip_prefix('=') {
                    // In a spreadsheet a leading `=` is a formula, never a literal.
                    cell.set_formula(f);
                } else {
                    cell.set_value(text);
                }
            }
        }
        applied += 1;
    }

    umya_spreadsheet::writer::xlsx::write(&book, file)
        .map_err(|e| format!("Failed to save {}: {:?}", path, e))?;

    Ok(format!("Updated {} ({} cell(s))", path, applied))
}

#[cfg(test)]
mod office_tests {
    use super::*;

    #[test]
    fn md_cell_escapes_pipes_and_flattens_newlines() {
        assert_eq!(md_cell("a|b"), "a\\|b");
        assert_eq!(md_cell(" x\ny "), "x y");
    }

    #[test]
    fn ooxml_text_extracts_runs_and_breaks_paragraphs() {
        let xml = r#"<w:document><w:body>
            <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p>
            <w:p><w:r><w:t>Second</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let out = ooxml_text(xml, "w:t", "w:p");
        let lines: Vec<&str> = out.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        assert_eq!(lines, vec!["Hello world", "Second"]);
    }

    #[test]
    fn ooxml_text_ignores_markup_outside_text_runs() {
        let xml = r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Only this</w:t></w:r></w:p>"#;
        assert_eq!(ooxml_text(xml, "w:t", "w:p").trim(), "Only this");
    }

    #[test]
    fn ooxml_text_unescapes_entities() {
        let xml = r#"<w:p><w:r><w:t>a &amp; b &lt;c&gt;</w:t></w:r></w:p>"#;
        assert_eq!(ooxml_text(xml, "w:t", "w:p").trim(), "a & b <c>");
    }

    #[test]
    fn ooxml_text_survives_malformed_xml() {
        // Truncated input must not panic — return whatever was parsed.
        let out = ooxml_text("<w:p><w:r><w:t>partial", "w:t", "w:p");
        assert!(out.is_empty() || out.contains("partial"));
    }

    /// Round-trip: write a workbook, then read it back through the same path the
    /// agent uses. Proves the two halves actually agree on a real file.
    #[test]
    fn xlsx_round_trip_write_then_read() {
        use rust_xlsxwriter::{Format, Workbook};
        let dir = std::env::temp_dir();
        let path = dir.join(format!("jhai_office_rt_{}.xlsx", std::process::id()));

        // Write (mirrors write_xlsx's cell handling).
        let mut book = Workbook::new();
        let header = Format::new().set_bold();
        {
            let sheet = book.add_worksheet();
            sheet.set_name("Data").unwrap();
            sheet.write_string_with_format(0, 0, "name", &header).unwrap();
            sheet.write_string_with_format(0, 1, "qty", &header).unwrap();
            sheet.write_string(1, 0, "widget").unwrap();
            sheet.write_number(1, 1, 42.0).unwrap();
        }
        book.save(&path).unwrap();

        // Read back through the production path.
        let bytes = std::fs::read(&path).unwrap();
        let doc = read_spreadsheet(bytes, "xlsx", 60_000, None).unwrap();
        assert_eq!(doc.kind, "xlsx");
        assert_eq!(doc.parts, vec!["Data".to_string()]);
        assert!(doc.text.contains("## Sheet: Data"));
        assert!(doc.text.contains("widget"), "cell text missing: {}", doc.text);
        assert!(doc.text.contains("42"), "number missing: {}", doc.text);
        // A Markdown table needs its separator row.
        assert!(doc.text.contains("---"));
        assert!(!doc.truncated);

        let _ = std::fs::remove_file(path);
    }

    /// Dates arrived as raw Excel serials ("46231") before cell_text existed —
    /// unreadable, and easy for a model to mistake for a quantity.
    #[test]
    fn date_cells_render_as_dates_not_serial_numbers() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let path = std::env::temp_dir().join(format!("jhai_office_date_{}.xlsx", std::process::id()));

        let mut book = Workbook::new();
        {
            let sheet = book.add_worksheet();
            let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
            let dt_fmt = Format::new().set_num_format("yyyy-mm-dd hh:mm");
            sheet.write_string(0, 0, "due").unwrap();
            sheet.write_datetime_with_format(1, 0, &ExcelDateTime::from_ymd(2026, 7, 28).unwrap(), &date_fmt).unwrap();
            sheet.write_datetime_with_format(
                2, 0,
                &ExcelDateTime::from_ymd(2026, 7, 28).unwrap().and_hms(13, 45, 0).unwrap(),
                &dt_fmt,
            ).unwrap();
            // A plain number must stay a number.
            sheet.write_number(3, 0, 46231.0).unwrap();
        }
        book.save(&path).unwrap();

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, None).unwrap();
        assert!(doc.text.contains("2026-07-28"), "date not rendered: {}", doc.text);
        assert!(doc.text.contains("2026-07-28 13:45:00"), "datetime not rendered: {}", doc.text);
        assert!(doc.text.contains("46231"), "plain number should stay numeric: {}", doc.text);
        // A whole day must not carry a meaningless midnight component.
        assert!(!doc.text.contains("2026-07-28 00:00:00"), "midnight not trimmed: {}", doc.text);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cell_text_passes_non_dates_through_unchanged() {
        use calamine::Data;
        assert_eq!(cell_text(&Data::String("hi".into())), "hi");
        assert_eq!(cell_text(&Data::Int(42)), "42");
        // calamine prints booleans lowercase, not Excel's TRUE/FALSE.
        assert_eq!(cell_text(&Data::Bool(true)), "true");
        assert_eq!(cell_text(&Data::Empty), "");
    }

    /// Build a workbook with several sheets for the selection tests.
    fn multi_sheet_workbook(path: &std::path::Path, sheets: &[(&str, usize)]) {
        use rust_xlsxwriter::Workbook;
        let mut book = Workbook::new();
        for (name, rows) in sheets {
            let sheet = book.add_worksheet();
            sheet.set_name(*name).unwrap();
            sheet.write_string(0, 0, "col").unwrap();
            for r in 1..=*rows {
                sheet.write_string(r as u32, 0, format!("{}-row{}", name, r)).unwrap();
            }
        }
        book.save(path).unwrap();
    }

    /// The index must come first: one read has to be enough to decide where to
    /// look next, even when the body gets cut.
    #[test]
    fn workbook_read_starts_with_an_index_of_every_sheet() {
        let path = std::env::temp_dir().join(format!("jhai_office_idx_{}.xlsx", std::process::id()));
        multi_sheet_workbook(&path, &[("Alpha", 2), ("Beta", 2), ("Gamma", 2)]);

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, None).unwrap();
        let idx = doc.text.find("# Workbook index").expect("no index");
        assert!(idx < doc.text.find("## Sheet: Alpha").unwrap(), "index must precede the sheets");
        for name in ["Alpha", "Beta", "Gamma"] {
            assert!(doc.text.contains(name), "{} missing from index: {}", name, doc.text);
        }
        assert_eq!(doc.parts, vec!["Alpha", "Beta", "Gamma"]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_named_sheet_returns_only_that_sheet() {
        let path = std::env::temp_dir().join(format!("jhai_office_one_{}.xlsx", std::process::id()));
        multi_sheet_workbook(&path, &[("Alpha", 2), ("Beta", 2)]);

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, Some("Beta")).unwrap();
        assert!(doc.text.contains("Beta-row1"));
        assert!(!doc.text.contains("Alpha-row1"), "other sheets leaked: {}", doc.text);
        // No index when one sheet was asked for — the caller already knows.
        assert!(!doc.text.contains("# Workbook index"));
        // parts still names every sheet, so the model can pivot.
        assert_eq!(doc.parts, vec!["Alpha", "Beta"]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sheet_selection_is_case_insensitive() {
        let path = std::env::temp_dir().join(format!("jhai_office_ci_{}.xlsx", std::process::id()));
        multi_sheet_workbook(&path, &[("Summary", 1)]);
        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, Some("summary")).unwrap();
        assert!(doc.text.contains("## Sheet: Summary"));
        let _ = std::fs::remove_file(path);
    }

    /// An unknown name must say what IS there — a bare "not found" costs the
    /// model another blind round-trip.
    #[test]
    fn an_unknown_sheet_name_lists_the_real_ones() {
        let path = std::env::temp_dir().join(format!("jhai_office_bad_{}.xlsx", std::process::id()));
        multi_sheet_workbook(&path, &[("Alpha", 1), ("Beta", 1)]);
        let err = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, Some("Nope")).unwrap_err();
        assert!(err.contains("Alpha") && err.contains("Beta"), "err did not list sheets: {}", err);
        let _ = std::fs::remove_file(path);
    }

    /// The old behaviour silently truncated, leaving the model believing it had
    /// seen the whole workbook.
    #[test]
    fn an_oversized_workbook_names_the_sheets_it_left_out() {
        let path = std::env::temp_dir().join(format!("jhai_office_big_{}.xlsx", std::process::id()));
        multi_sheet_workbook(&path, &[("Alpha", 200), ("Beta", 200), ("Omega", 200)]);

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 900, None).unwrap();
        assert!(doc.text.contains("# Workbook index"), "index dropped under pressure: {}", doc.text);
        assert!(doc.text.contains("Omega"), "omitted sheet not named: {}", doc.text);
        assert!(doc.text.contains("sheet="), "no instruction to fetch the rest: {}", doc.text);
        assert!(doc.truncated);
        let _ = std::fs::remove_file(path);
    }

    // ── Cell addresses ───────────────────────────────────────────────────────

    #[test]
    fn col_letter_matches_spreadsheet_lettering() {
        assert_eq!(col_letter(0), "A");
        assert_eq!(col_letter(25), "Z");
        // The rollover is where a naive base-26 conversion goes wrong.
        assert_eq!(col_letter(26), "AA");
        assert_eq!(col_letter(27), "AB");
        assert_eq!(col_letter(51), "AZ");
        assert_eq!(col_letter(52), "BA");
        assert_eq!(col_letter(701), "ZZ");
        assert_eq!(col_letter(702), "AAA");
    }

    /// The model cannot ask to write "the cell next to the total" — it has to say
    /// D14. Without addresses in the read output, update_xlsx is unusable.
    #[test]
    fn a_sheet_read_carries_column_letters_and_row_numbers() {
        use rust_xlsxwriter::Workbook;
        let path = std::env::temp_dir().join(format!("jhai_office_addr_{}.xlsx", std::process::id()));
        let mut book = Workbook::new();
        {
            let sheet = book.add_worksheet();
            sheet.set_name("Data").unwrap();
            sheet.write_string(0, 0, "name").unwrap();
            sheet.write_string(0, 1, "qty").unwrap();
            sheet.write_string(1, 0, "widget").unwrap();
            sheet.write_number(1, 1, 42.0).unwrap();
        }
        book.save(&path).unwrap();

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, None).unwrap();
        assert!(doc.text.contains("| A | B |"), "no column letters: {}", doc.text);
        assert!(doc.text.contains("**1**"), "no row numbers: {}", doc.text);
        assert!(doc.text.contains("**2**"), "no row numbers: {}", doc.text);
        let _ = std::fs::remove_file(path);
    }

    /// A merged title spanning four columns arrives as one value and three blanks.
    /// A model that does not know they were merged reads three missing fields.
    #[test]
    fn merged_ranges_are_reported() {
        use umya_spreadsheet as umya;
        let path = std::env::temp_dir().join(format!("jhai_office_merge_{}.xlsx", std::process::id()));
        let mut book = umya::new_file();
        {
            let sheet = book.get_sheet_by_name_mut("Sheet1").unwrap();
            sheet.get_cell_mut("A1").set_value("Quarterly report");
            sheet.add_merge_cells("A1:C1");
            sheet.get_cell_mut("A2").set_value("item");
        }
        umya::writer::xlsx::write(&book, &path).unwrap();

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, None).unwrap();
        assert!(doc.text.contains("A1:C1"), "merge not reported: {}", doc.text);
        assert!(doc.text.contains("Merged ranges"), "no explanation: {}", doc.text);
        let _ = std::fs::remove_file(path);
    }

    // ── docx writing ─────────────────────────────────────────────────────────

    #[test]
    fn xml_esc_neutralises_what_breaks_word() {
        // Word rejects the WHOLE document on a stray ampersand.
        assert_eq!(xml_esc("a & b <c>"), "a &amp; b &lt;c&gt;");
    }

    #[test]
    fn docx_body_maps_headings_to_word_styles() {
        let body = docx_body("# Title
## Section");
        assert!(body.contains(r#"<w:pStyle w:val="Heading1"/>"#), "{}", body);
        assert!(body.contains(r#"<w:pStyle w:val="Heading2"/>"#), "{}", body);
        assert!(body.contains("Title"));
    }

    #[test]
    fn docx_body_caps_heading_depth_at_six() {
        // Word has Heading1..6; a 7-hash line is prose, not a heading.
        let body = docx_body("####### too deep");
        assert!(!body.contains("Heading7"), "{}", body);
        assert!(body.contains("too deep"));
    }

    #[test]
    fn docx_body_keeps_blank_lines_as_empty_paragraphs() {
        // Dropping them runs the text together, which is the usual complaint about
        // generated documents.
        let body = docx_body("one

two");
        assert!(body.contains("<w:p/>"), "{}", body);
    }

    #[test]
    fn docx_body_renders_lists() {
        let body = docx_body("- first
2. second");
        assert!(body.contains("ListParagraph"), "{}", body);
        assert!(body.contains("first"));
        assert!(body.contains("second"));
    }

    #[test]
    fn docx_runs_handles_bold_and_italic() {
        let bold = docx_runs("plain **strong** tail");
        assert!(bold.contains("<w:b/>"), "{}", bold);
        assert!(bold.contains("plain"));
        assert!(bold.contains("strong"));
        assert!(bold.contains("tail"));

        let ital = docx_runs("an *emphasis* here");
        assert!(ital.contains("<w:i/>"), "{}", ital);
        // Bold must win over italic on the same marker run.
        assert!(!docx_runs("**b**").contains("<w:i/>"));
    }

    #[test]
    fn docx_runs_degrades_on_an_unclosed_marker() {
        // Literal text beats a corrupted run structure.
        let out = docx_runs("half **open");
        assert!(out.contains("half **open"), "{}", out);
    }

    #[test]
    fn docx_runs_escapes_inside_a_run() {
        assert!(docx_runs("**a & b**").contains("a &amp; b"));
    }

    #[test]
    fn docx_body_never_emits_an_empty_run() {
        // An empty <w:r> with no <w:t> is what makes Word report a corrupt file.
        assert!(docx_runs("").contains("<w:t"));
    }

    #[test]
    fn image_mime_accepts_vision_formats_and_skips_vector_ones() {
        assert_eq!(image_mime("ppt/media/image1.PNG"), Some("image/png"));
        assert_eq!(image_mime("word/media/a.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime("xl/media/b.gif"), Some("image/gif"));
        assert_eq!(image_mime("xl/media/c.webp"), Some("image/webp"));
        // No model accepts these, so sending them would just draw an API error.
        assert_eq!(image_mime("ppt/media/image2.emf"), None);
        assert_eq!(image_mime("ppt/media/image3.wmf"), None);
        assert_eq!(image_mime("ppt/media/notes.xml"), None);
    }

    #[test]
    fn extract_images_pulls_media_and_skips_decoration() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default();
            // A real diagram: over the decoration floor.
            zw.start_file("ppt/media/image1.png", opts).unwrap();
            zw.write_all(&vec![7u8; MIN_IMAGE_BYTES * 2]).unwrap();
            // A bullet icon: under the floor, must be skipped.
            zw.start_file("ppt/media/image2.png", opts).unwrap();
            zw.write_all(&vec![1u8; 128]).unwrap();
            // Vector: unusable by any model.
            zw.start_file("ppt/media/image3.emf", opts).unwrap();
            zw.write_all(&vec![2u8; MIN_IMAGE_BYTES * 2]).unwrap();
            // Not media at all.
            zw.start_file("ppt/slides/slide1.xml", opts).unwrap();
            zw.write_all(&vec![3u8; MIN_IMAGE_BYTES * 2]).unwrap();
            zw.finish().unwrap();
        }

        let imgs = extract_images(&buf);
        assert_eq!(imgs.len(), 1, "got: {:?}", imgs.iter().map(|i| &i.name).collect::<Vec<_>>());
        assert_eq!(imgs[0].name, "ppt/media/image1.png");
        assert_eq!(imgs[0].mime, "image/png");
        assert!(!imgs[0].data.is_empty());
    }

    #[test]
    fn extract_images_caps_the_count_and_keeps_the_largest() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default();
            // 8 images of increasing size; only the 6 largest may survive.
            for i in 1..=8u8 {
                zw.start_file(format!("word/media/image{}.png", i), opts).unwrap();
                zw.write_all(&vec![i; MIN_IMAGE_BYTES + (i as usize) * 4096]).unwrap();
            }
            zw.finish().unwrap();
        }

        let imgs = extract_images(&buf);
        assert_eq!(imgs.len(), MAX_IMAGES);
        let names: Vec<&str> = imgs.iter().map(|i| i.name.as_str()).collect();
        assert!(!names.contains(&"word/media/image1.png"), "smallest should have been dropped");
        assert!(names.contains(&"word/media/image8.png"), "largest should have been kept");
    }

    #[test]
    fn extract_images_tolerates_a_non_package() {
        assert!(extract_images(b"not a zip").is_empty());
    }

    #[test]
    fn spreadsheet_rejects_an_unknown_extension() {
        assert!(read_spreadsheet(vec![], "rtf", 100, None).is_err());
    }

    #[test]
    fn docx_reader_rejects_a_non_package() {
        assert!(read_docx(b"not a zip".to_vec(), 100).is_err());
    }

    #[test]
    fn pptx_reader_rejects_a_non_package() {
        assert!(read_pptx(b"not a zip".to_vec(), 100).is_err());
    }

    #[test]
    fn pptx_slide_ordering_is_numeric_not_lexicographic() {
        // slide10 must sort AFTER slide2 — the bug a plain string sort creates.
        let mut names: Vec<(usize, String)> = ["slide1", "slide10", "slide2"]
            .iter()
            .map(|n| {
                let num = n.trim_start_matches("slide").parse::<usize>().unwrap();
                (num, n.to_string())
            })
            .collect();
        names.sort_by_key(|(n, _)| *n);
        assert_eq!(names.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>(),
                   vec!["slide1", "slide2", "slide10"]);
    }
}


// ── Spreadsheet dependency extraction ──────────────────────────────────────
//
// A formula is an explicit dependency edge, and a more reliable one than an
// import: `=SUM(Sheet2!B:B)` states outright that this sheet reads that one.
// Nothing is inferred, which is why the result can go into the same `edges`
// table as code imports and be trusted the same way.
//
// This matters beyond spreadsheets being common. In a lot of enterprise work the
// real system knowledge is in the workbook, not the code — the table definitions,
// the business rules, the mapping. Indexing only source leaves the agent blind to
// the half that decides the answer.

/// One sheet-to-sheet reference discovered in a workbook.
#[derive(Debug, Serialize, PartialEq)]
pub struct SheetRef {
    pub from_sheet: String,
    pub to_sheet: String,
    /// A formula showing the reference, for the human reading the index.
    pub example: String,
}

/// Sheet names referenced by a formula.
///
/// Excel spells a cross-sheet reference `Sheet2!B4`, or `'My Sheet'!B4` when the
/// name needs quoting. Both forms are matched; a bare `B4` is a same-sheet
/// reference and carries no edge.
pub(crate) fn sheets_in_formula(formula: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = formula.chars().collect();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == '\'' {
            // Quoted name: everything to the closing quote, which must be
            // followed by '!' to be a sheet reference rather than a string.
            if let Some(end) = (i + 1..bytes.len()).find(|&j| bytes[j] == '\'') {
                if end + 1 < bytes.len() && bytes[end + 1] == '!' {
                    let name: String = bytes[i + 1..end].iter().collect();
                    if !name.is_empty() && !out.contains(&name) {
                        out.push(name);
                    }
                }
                i = end + 1;
                continue;
            }
        }
        if bytes[i] == '!' && i > 0 {
            // Unquoted name: walk back over the identifier before the '!'.
            let mut start = i;
            while start > 0 {
                let c = bytes[start - 1];
                if c.is_alphanumeric() || c == '_' || c == '.' {
                    start -= 1;
                } else {
                    break;
                }
            }
            if start < i {
                let name: String = bytes[start..i].iter().collect();
                // A leading digit means it is a cell/row token, not a sheet.
                if !name.chars().next().map_or(true, |c| c.is_ascii_digit())
                    && !out.contains(&name)
                {
                    out.push(name);
                }
            }
        }
        i += 1;
    }
    out
}

/// Cross-sheet references in a workbook, as edges.
///
/// Only `xlsx`/`xlsm`: calamine exposes formulas for the OOXML formats, and the
/// legacy binary `.xls` stores them in a form it does not surface.
#[tauri::command]
pub async fn spreadsheet_refs(
    path: String,
    guard: State<'_, PathGuard>,
) -> Result<Vec<SheetRef>, String> {
    use calamine::{open_workbook_from_rs, Reader, Xlsx};

    guard.ensure_allowed(&path)?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "xlsx" | "xlsm") {
        return Ok(Vec::new());
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    let mut wb = open_workbook_from_rs::<Xlsx<_>, _>(Cursor::new(bytes))
        .map_err(|e| format!("Failed to open workbook: {}", e))?;

    let names: Vec<String> = wb.sheet_names().to_vec();
    let mut out: Vec<SheetRef> = Vec::new();
    for name in &names {
        let formulas = match wb.worksheet_formula(name) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for (_, _, f) in formulas.used_cells() {
            if f.is_empty() {
                continue;
            }
            for target in sheets_in_formula(f) {
                // Only references to sheets that exist: `SUM!` in a name would
                // otherwise be recorded as a phantom dependency.
                if &target == name || !names.contains(&target) {
                    continue;
                }
                if out.iter().any(|r| r.from_sheet == *name && r.to_sheet == target) {
                    continue;
                }
                out.push(SheetRef {
                    from_sheet: name.clone(),
                    to_sheet: target,
                    example: f.chars().take(120).collect(),
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod sheet_ref_tests {
    use super::sheets_in_formula;

    #[test]
    fn finds_a_plain_cross_sheet_reference() {
        assert_eq!(sheets_in_formula("=SUM(Sheet2!B2:B9)"), vec!["Sheet2"]);
    }

    #[test]
    fn finds_a_quoted_sheet_name_with_spaces() {
        assert_eq!(sheets_in_formula("='Master Data'!A1"), vec!["Master Data"]);
    }

    #[test]
    fn reports_each_referenced_sheet_once() {
        assert_eq!(
            sheets_in_formula("=Sheet2!A1+Sheet2!A2+Sheet3!A1"),
            vec!["Sheet2", "Sheet3"]
        );
    }

    #[test]
    fn a_same_sheet_formula_carries_no_edge() {
        assert!(sheets_in_formula("=SUM(B2:B9)").is_empty());
        assert!(sheets_in_formula("=A1*1.08").is_empty());
    }

    #[test]
    fn does_not_mistake_a_function_call_for_a_sheet() {
        // No '!' means no reference, however much it looks like a name.
        assert!(sheets_in_formula("=VLOOKUP(A1,B:C,2,FALSE)").is_empty());
    }
}
