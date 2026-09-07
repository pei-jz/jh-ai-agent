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
//   xlsx (edit in place)     → commands/xlsx_edit.rs, which rewrites the target
//                              worksheet's XML and copies every other part of the
//                              package through as bytes, so nothing it does not
//                              understand can be lost
//   docx                     → OOXML written directly with the zip writer
//
// Not implemented: writing pptx. A deck is a layout problem (EMU geometry, theme
// references, per-slide relationship parts) rather than a document one, and an HTML
// deck the agent can actually SEE and correct is a better answer than a fragile
// pptx it cannot. Say so rather than emitting a broken file.

use serde::Serialize;
use std::io::{Cursor, Read};
use crate::path_guard::PathGuard;
// Value and formula edits go through the surgical writer; see its header.
use super::xlsx_edit;
// Column widths, number formats and the house styles a new workbook gets.
use super::xlsx_style;
// Appending a format to the stylesheet, so a restyle never rebuilds the file.
use super::xlsx_stylesheet;
// Reading the existing formatting back out, so an edit can match it.
use super::xlsx_inspect;
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
    /// A summary of the sheet FORMATTING, when the caller asked for it.
    ///
    /// Values alone are enough to answer a question and not enough to change
    /// the file in keeping with itself — an agent that has never seen the
    /// existing format has to invent one. See commands/xlsx_inspect.rs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
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
    Ok(OfficeDoc { text, kind: ext.to_string(), parts, truncated, images: Vec::new(), format: None })
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
        format: None,
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
        format: None,
    })
}

/// Read an Office document as Markdown the model can reason about.
#[tauri::command]
pub async fn read_office_document(
    path: String,
    max_chars: Option<usize>,
    sheet: Option<String>,
    include_images: Option<bool>,
    with_format: Option<bool>,
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

    // The formatting summary comes from the package, like the images, and only
    // for the formats that have one. A failure here must not cost the caller the
    // document: an unreadable stylesheet is a reason to omit the summary, not to
    // refuse the read.
    let format = if with_format.unwrap_or(false) && matches!(ext.as_str(), "xlsx" | "xlsm") {
        match xlsx_inspect::describe(&bytes, want_sheet) {
            Ok(s) => Some(s),
            Err(e) => Some(format!("(書式を読めませんでした: {})", e)),
        }
    } else {
        None
    };

    let mut doc = match ext.as_str() {
        "xlsx" | "xlsm" | "xls" | "ods" => read_spreadsheet(bytes, &ext, cap, want_sheet),
        "docx" => read_docx(bytes, cap),
        "pptx" => read_pptx(bytes, cap),
        // The "cannot" answers. Three parts, like every other error here: what
        // happened, that nothing ran, and what to do instead. An agent told only
        // that something is unsupported invents its own way round —
        // docs/design/tool-failure-policy.md §2 B.
        "doc" | "ppt" => Err(format!(
            "Cannot read a legacy binary .{}: this reader handles the OOXML formats only, and              nothing was read. Open it and save it as .{}x, then read that — or ask the user to.",
            ext, ext
        )),
        other => Err(format!(
            "Not an Office document: .{}. Nothing was read. read_office handles              xlsx / xlsm / xls / ods / docx / pptx; for anything else use read_file.",
            other
        )),
    }?;
    doc.images = images;
    doc.format = format;
    Ok(doc)
}

/// One sheet of a workbook to be written.
///
/// Cells stay plain JSON values (number / string / bool / null) — that is what an
/// LLM produces naturally. A cell may OPTIONALLY be an object {"v": value, "style": name}
/// to reference a style from the sheet-level `styles` table; anything without a
/// reference uses the default styling (first row bold header, everything else plain).
#[derive(serde::Deserialize, Debug)]
pub struct SheetSpec {
    pub name: Option<String>,
    /// Row-major cells. The first row is styled as a header unless `header` is false.
    pub rows: Vec<Vec<serde_json::Value>>,
    /// Optional per-sheet design: column widths, print setup, frozen header row.
    #[serde(default)]
    pub design: Option<serde_json::Value>,
    /// Optional style table: name → {bold, italic, size, font, color, bg, border, align, …}.
    #[serde(default)]
    pub styles: Option<serde_json::Value>,
}

/// A named cell style, parsed from the sheet-level `styles` table. Unknown keys are
/// ignored (the LLM gets a working file instead of a hard error on a typo).
#[derive(Debug, Default)]
struct CellStyle {
    bold: bool,
    italic: bool,
    size: Option<f64>,
    font: Option<String>,
    color: Option<String>,       // font colour
    bg: Option<String>,          // fill colour
    border: Option<String>,      // "thin" | "medium" | "thick" (all sides)
    align: Option<String>,       // "left" | "center" | "right"
    valign: Option<String>,      // "top" | "middle" | "bottom"
    numfmt: Option<String>,      // e.g. "#,##0", "0.00", "yyyy-mm-dd"
    wrap: bool,
}

impl CellStyle {
    fn from_value(v: &serde_json::Value) -> Option<Self> {
        let obj = v.as_object()?;
        let s = CellStyle {
            bold: obj.get("bold").and_then(serde_json::Value::as_bool).unwrap_or(false),
            italic: obj.get("italic").and_then(serde_json::Value::as_bool).unwrap_or(false),
            size: obj.get("size").and_then(serde_json::Value::as_f64),
            font: obj.get("font").and_then(serde_json::Value::as_str).map(str::to_string),
            color: obj.get("color").and_then(serde_json::Value::as_str).map(str::to_string),
            bg: obj.get("bg").and_then(serde_json::Value::as_str).map(str::to_string),
            border: obj.get("border").and_then(serde_json::Value::as_str).map(str::to_string),
            align: obj.get("align").and_then(serde_json::Value::as_str).map(str::to_string),
            valign: obj.get("valign").and_then(serde_json::Value::as_str).map(str::to_string),
            numfmt: obj.get("numfmt").and_then(serde_json::Value::as_str).map(str::to_string),
            wrap: obj.get("wrap").and_then(serde_json::Value::as_bool).unwrap_or(false),
        };
        Some(s)
    }

    /// Build a rust_xlsxwriter Format from the parsed fields.
    fn to_format(&self) -> rust_xlsxwriter::Format {
        use rust_xlsxwriter::{FormatAlign, FormatBorder};
        let mut f = rust_xlsxwriter::Format::new();
        if self.bold { f = f.set_bold(); }
        if self.italic { f = f.set_italic(); }
        if let Some(sz) = self.size { f = f.set_font_size(sz); }
        if let Some(font) = &self.font { f = f.set_font_name(font); }
        if let Some(c) = &self.color {
            if let Some(rgb) = parse_color(c) { f = f.set_font_color(rgb); }
        }
        if let Some(c) = &self.bg {
            if let Some(rgb) = parse_color(c) { f = f.set_background_color(rgb); }
        }
        if let Some(b) = &self.border {
            let fb = match b.as_str() {
                "medium" => FormatBorder::Medium,
                "thick" => FormatBorder::Thick,
                _ => FormatBorder::Thin,
            };
            f = f.set_border(fb);
        }
        if let Some(a) = &self.align {
            let fa = match a.as_str() {
                "center" => FormatAlign::Center,
                "right" => FormatAlign::Right,
                _ => FormatAlign::Left,
            };
            f = f.set_align(fa);
        }
        if let Some(a) = &self.valign {
            let fa = match a.as_str() {
                "top" => FormatAlign::Top,
                "middle" => FormatAlign::VerticalCenter,
                _ => FormatAlign::Bottom,
            };
            f = f.set_align(fa);
        }
        if let Some(n) = &self.numfmt { f = f.set_num_format(n); }
        // `wrap` is opt-in: the DEFAULT is no wrap (a spreadsheet's rows stay
        // one line tall unless the caller explicitly asks for wrapping). Be
        // explicit about it so a library default change can never flip it on.
        if self.wrap { f = f.set_text_wrap(); } else { f = f.unset_text_wrap(); }
        f
    }
}

/// Accept "#RRGGBB", "RRGGBB" (Excel style, rust_xlsxwriter uses this) or a
/// few common names. Return an Excel "FFRRGGBB" ARGB int for rust_xlsxwriter.
fn parse_color(s: &str) -> Option<u32> {
    let t = s.trim();
    let hex = t.strip_prefix('#').unwrap_or(t);
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return u32::from_str_radix(hex, 16).ok();
    }
    let named = match t.to_lowercase().as_str() {
        "black" => "000000", "white" => "FFFFFF", "red" => "FF0000",
        "green" => "00FF00", "blue" => "0000FF", "yellow" => "FFFF00",
        "cyan" => "00FFFF", "magenta" => "FF00FF", "gray" | "grey" => "808080",
        "orange" => "FFA500", "lightgray" | "lightgrey" => "D3D3D3",
        "darkgray" | "darkgrey" => "A9A9A9", "navy" => "000080",
        "teal" => "008080", "maroon" => "800000", "olive" => "808000",
        "silver" => "C0C0C0", "lime" => "00FF00", "purple" => "800080",
        "aqua" => "00FFFF", "fuchsia" => "FF00FF",
        _ => return None,
    };
    u32::from_str_radix(named, 16).ok()
}

/// Merge specification: { from: "A1", to: "C1" } or { row: 0, col: 0, span: 2 }.
fn merge_ranges(design: &serde_json::Value) -> Vec<(u32, u16, u32, u16)> {
    let mut out = Vec::new();
    let arr = match design.get("merges").and_then(serde_json::Value::as_array) {
        Some(a) => a,
        None => return out,
    };
    for m in arr {
        if let Some(obj) = m.as_object() {
            if let (Some(fr), Some(tc)) = (obj.get("from"), obj.get("to")) {
                if let (Some(f), Some(t)) = (fr.as_str(), tc.as_str()) {
                    if let (Some(a1), Some(a2)) = (a1_to_rc(f), a1_to_rc(t)) {
                        out.push((a1.0, a1.1, a2.0, a2.1));
                        continue;
                    }
                }
            }
            if let (Some(r), Some(c), Some(span)) = (
                obj.get("row").and_then(serde_json::Value::as_u64),
                obj.get("col").and_then(serde_json::Value::as_u64),
                obj.get("span").and_then(serde_json::Value::as_u64),
            ) {
                let r = r as u32;
                let c = c as u16;
                out.push((r, c, r, c + span.saturating_sub(1) as u16));
            }
        }
    }
    out
}

/// "A1" / "C3" → (row0, col0). Rows are 1-based in A1 notation, so subtract 1.
fn a1_to_rc(s: &str) -> Option<(u32, u16)> {
    let bytes = s.as_bytes();
    if bytes.is_empty() { return None; }
    let mut col: u32 = 0;
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        let b = bytes[i].to_ascii_uppercase();
        if !(b'A'..=b'Z').contains(&b) { return None; }
        col = col * 26 + (b - b'A' + 1) as u32;
        i += 1;
    }
    if i == 0 || i == bytes.len() { return None; }
    let row: u32 = bytes[i..].iter().try_fold(0u32, |acc, &b| {
        if b.is_ascii_digit() { Some(acc * 10 + (b - b'0') as u32) } else { None }
    })?;
    if row == 0 { return None; }
    Some((row - 1, (col - 1) as u16))
}

/// The value a cell carries: a plain JSON value, or {"v": value, "style": name}.
fn cell_value(cell: &serde_json::Value) -> (&serde_json::Value, Option<&str>) {
    if let Some(obj) = cell.as_object() {
        if obj.contains_key("v") {
            return (obj.get("v").unwrap_or(&serde_json::Value::Null), obj.get("style").and_then(serde_json::Value::as_str));
        }
    }
    (cell, None)
}

/// Write one cell (value + optional format) into the sheet.
///
/// rust_xlsxwriter's `merge_range` OVERWRITES the whole range with a single
/// string, so the natural "write cells, then merge" order would blank the
/// top-left value. This helper lets the merge pass re-write it afterwards.
fn write_cell(
    sheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    cell: &serde_json::Value,
    fmt: Option<&rust_xlsxwriter::Format>,
) -> Result<(), rust_xlsxwriter::XlsxError> {
    // The caller has already resolved the format (apply_sheet's `resolve`
    // picks named style > header > banding > column default) and passes it in
    // as `fmt`; there is nothing left to work out here.
    let (val, _) = cell_value(cell);
    match val {
        serde_json::Value::Number(n) => {
            let v = n.as_f64().unwrap_or(0.0);
            match fmt {
                Some(f) => sheet.write_number_with_format(row, col, v, f).map(|_| ()),
                None => sheet.write_number(row, col, v).map(|_| ()),
            }
        }
        serde_json::Value::Bool(b) => match fmt {
            Some(f) => sheet.write_boolean_with_format(row, col, *b, f).map(|_| ()),
            None => sheet.write_boolean(row, col, *b).map(|_| ()),
        },
        serde_json::Value::Null => Ok(()),
        other => {
            let s = other.as_str().map(str::to_string)
                .unwrap_or_else(|| other.to_string());
            match fmt {
                Some(f) => sheet.write_string_with_format(row, col, &s, f).map(|_| ()),
                None => sheet.write_string(row, col, &s).map(|_| ()),
            }
        }
    }
}

/// Write an .xlsx workbook. Numbers stay numeric so Excel can compute on them.
/// Lay one sheet out: values, preset, widths, print setup.
///
/// Split out of write_xlsx so the LOOK can be tested. The command itself needs
/// a Tauri State and a real path, which is exactly the machinery a test of
/// "does a header get a filter and a sensible column width" should not need.
pub fn apply_sheet(
    sheet: &mut rust_xlsxwriter::Worksheet,
    spec: &SheetSpec,
    preset: Option<&str>,
    i: usize,
) -> Result<(), String> {
    use rust_xlsxwriter::{Format, FormatAlign, FormatBorder};

    if let Some(name) = spec.name.as_deref().filter(|n| !n.is_empty()) {
        // Excel rejects >31 chars and a few characters outright; fall back to
        // the default name rather than failing the whole write.
        let safe: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
        let _ = sheet.set_name(&safe);
    }

    // Named styles: parsed once per sheet, referenced by cells via {"v":…,"style":…}.
    let mut styles: std::collections::HashMap<String, Format> = std::collections::HashMap::new();
    if let Some(sv) = spec.styles.as_ref().and_then(serde_json::Value::as_object) {
        for (k, v) in sv {
            if let Some(cs) = CellStyle::from_value(v) {
                styles.insert(k.clone(), cs.to_format());
            }
        }
    }

    let design = spec.design.clone().unwrap_or(serde_json::Value::Null);
    let use_header = design.get("header").and_then(serde_json::Value::as_bool).unwrap_or(true);

    // A preset is the answer to "what should this look like if nobody
    // says?" — and nobody ever says. A model composing a spreadsheet is
    // thinking about the numbers, so left to itself it produced 8.43-wide
    // columns, amounts reading 1800, and everything flush left.
    let look = xlsx_style::preset(
        design
            .get("preset")
            .and_then(serde_json::Value::as_str)
            .or(preset),
    );

    // ── what each column holds ──────────────────────────────────────────
    let ncols = spec.rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let data_start = if use_header { 1 } else { 0 };
    let mut col_kind = Vec::with_capacity(ncols);
    let mut col_w = Vec::with_capacity(ncols);
    for c in 0..ncols {
        let header_text: Option<String> = if use_header {
            spec.rows
                .first()
                .and_then(|r| r.get(c))
                .and_then(|v| cell_value(v).0.as_str().map(str::to_string))
        } else {
            None
        };
        let values: Vec<&serde_json::Value> = spec
            .rows
            .iter()
            .skip(data_start)
            .filter_map(|r| r.get(c))
            .map(|v| cell_value(v).0)
            .collect();
        let kind = xlsx_style::infer_column(header_text.as_deref(), &values);
        let widths: Vec<f64> = values
            .iter()
            .map(|v| xlsx_style::rendered_width(v, kind, None))
            .collect();
        col_w.push(xlsx_style::column_width(header_text.as_deref(), &widths, kind));
        col_kind.push(kind);
    }

    // ── the formats the preset implies ──────────────────────────────────
    let grid = look.grid.and_then(parse_color);
    let mut header_fmt = Format::new().set_bold();
    if let Some(rgb) = look.header_fill.and_then(parse_color) {
        header_fmt = header_fmt.set_background_color(rgb);
    }
    if let Some(rgb) = look.header_font_color.and_then(parse_color) {
        header_fmt = header_fmt.set_font_color(rgb);
    }
    if let Some(f) = look.base_font {
        header_fmt = header_fmt.set_font_name(f);
    }
    if let Some(rgb) = grid {
        header_fmt = header_fmt.set_border(FormatBorder::Thin).set_border_color(rgb);
    }
    // A header is a label, not data: centre it and let it wrap so a long
    // title does not force the whole column wide.
    header_fmt = header_fmt
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_text_wrap();

    let build_col_fmt = |kind: xlsx_style::ColumnKind, zebra: Option<u32>| {
        let mut f = Format::new();
        if let Some(nf) = kind.num_format() {
            f = f.set_num_format(nf);
        }
        if kind.align_right() {
            f = f.set_align(FormatAlign::Right);
        }
        if kind.wrap() {
            f = f.set_text_wrap().set_align(FormatAlign::Top);
        } else {
            f = f.unset_text_wrap();
        }
        if let Some(rgb) = grid {
            f = f.set_border(FormatBorder::Thin).set_border_color(rgb);
        }
        if let Some(rgb) = zebra {
            f = f.set_background_color(rgb);
        }
        if let Some(name) = look.base_font {
            f = f.set_font_name(name);
        }
        f
    };
    let zebra_rgb = look.zebra.and_then(parse_color);
    let col_fmt: Vec<Format> = col_kind.iter().map(|k| build_col_fmt(*k, None)).collect();
    let col_fmt_alt: Vec<Format> = col_kind
        .iter()
        .map(|k| build_col_fmt(*k, zebra_rgb))
        .collect();

    // Widths: measured, unless the caller named one.
    let explicit = design.get("col_widths").and_then(serde_json::Value::as_object);
    for (c, w) in col_w.iter().enumerate() {
        let named = explicit.and_then(|o| {
            o.iter().find_map(|(k, v)| {
                match (a1_to_rc(&format!("{}1", k)), v.as_f64()) {
                    (Some((_, kc)), Some(kw)) if kc as usize == c => Some(kw),
                    _ => None,
                }
            })
        });
        let _ = sheet.set_column_width(c as u16, named.unwrap_or(*w));
    }

    // A named style the caller asked for beats the preset; the preset
    // beats nothing at all. That order is the whole contract: presets are
    // defaults, never overrides.
    let resolve = |r: usize, c: usize, style_name: Option<&str>| -> Option<&Format> {
        if let Some(f) = style_name.and_then(|n| styles.get(n)) {
            return Some(f);
        }
        if r == 0 && use_header {
            return Some(&header_fmt);
        }
        let banded = zebra_rgb.is_some() && (r - data_start) % 2 == 1;
        if banded { col_fmt_alt.get(c) } else { col_fmt.get(c) }
    };

    for (r, row) in spec.rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let (_, style_name) = cell_value(cell);
            write_cell(sheet, r as u32, c as u16, cell, resolve(r, c, style_name))
                .map_err(|e| format!("sheet {} cell ({},{}): {}", i, r, c, e))?;
        }
    }

    // Merges after cells: rust_xlsxwriter's merge_range overwrites the whole
    // range with one string, so merging here would blank the top-left value.
    // Re-write the top-left cell of each merged range afterwards.
    for (r1, c1, r2, c2) in merge_ranges(&design) {
        let _ = sheet.merge_range(r1, c1, r2, c2, "", &Format::default());
        if let Some(row) = spec.rows.get(r1 as usize) {
            if let Some(cell) = row.get(c1 as usize) {
                let (_, style_name) = cell_value(cell);
                let fmt = resolve(r1 as usize, c1 as usize, style_name);
                let _ = write_cell(sheet, r1, c1, cell, fmt);
            }
        }
    }

    // A header band wants room for the wrapped title it now allows.
    if use_header && !spec.rows.is_empty() {
        if let Some(h) = look.header_height {
            let _ = sheet.set_row_height(0, h);
        }
    }

    // Freeze the header row, so scrolling a long sheet keeps the labels.
    // An explicit `freeze` still wins, including `0` for "do not".
    match design.get("freeze").and_then(serde_json::Value::as_u64) {
        Some(f) => { let _ = sheet.set_freeze_panes(f as u32, 0); }
        None if look.freeze_header && use_header && !spec.rows.is_empty() => {
            let _ = sheet.set_freeze_panes(1, 0);
        }
        None => {}
    }

    // A filter on the header row is what makes a table usable at all.
    let nrows = spec.rows.len() as u32;
    if look.autofilter && use_header && nrows > 1 && ncols > 0 {
        let _ = sheet.autofilter(0, 0, nrows - 1, (ncols - 1) as u16);
    }

    // Print setup — the LLM most often wants the sheet to fit on one page.
    // Paper sizes are u8 constants in this rust_xlsxwriter version: A4=9,
    // A3=8, A5=11, Letter=1.
    let paper = design.get("paper").and_then(serde_json::Value::as_str).map(str::to_uppercase);
    let paper_code: u8 = match paper.as_deref() {
        Some("A3") => 8,
        Some("A5") => 11,
        Some("LETTER") => 1,
        _ => 9, // A4 — Excel's default anyway, set explicitly for determinism
    };
    let _ = sheet.set_paper_size(paper_code);
    match design.get("orientation").and_then(serde_json::Value::as_str) {
        Some("landscape") => { let _ = sheet.set_landscape(); }
        Some("portrait") => { let _ = sheet.set_portrait(); }
        _ => {}
    }
    // rust_xlsxwriter has no fit-to-pages; scaling is the closest equivalent.
    // fit_to_pages: N ⇒ scale down to roughly 1/N of the natural size, so
    // taller sheets land on fewer printed pages.
    if let Some(n) = design.get("fit_to_pages").and_then(serde_json::Value::as_u64) {
        let n = n.clamp(1, 100) as u16;
        let _ = sheet.set_print_scale((100.0 / n as f64).round() as u16);
    }
    if design.get("fit_to_width").and_then(serde_json::Value::as_bool).unwrap_or(look.fit_to_width) {
        // Fit the WIDTH to one page and leave the height to run on: a table
        // squeezed onto one sheet vertically is unreadable, while one that
        // spills sideways is unusable.
        let _ = sheet.set_print_fit_to_pages(1, 0);
    }
    if design.get("orientation").and_then(serde_json::Value::as_str).is_none() && look.landscape {
        let _ = sheet.set_landscape();
    }
    // Without this, page 2 of a printed table has no column headings at all.
    if look.repeat_header && use_header && nrows > 1 {
        let _ = sheet.set_repeat_rows(0, 0);
    }
    if look.page_footer {
        let _ = sheet.set_footer("&C&P / &N");
    }
    Ok(())
}

#[tauri::command]
pub async fn write_xlsx(
    path: String,
    sheets: Vec<SheetSpec>,
    overwrite: Option<bool>,
    preset: Option<String>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    use rust_xlsxwriter::Workbook;

    guard.ensure_allowed(&path)?;
    if sheets.is_empty() {
        return Err("write_xlsx requires at least one sheet".into());
    }

    // write_xlsx BUILDS A NEW WORKBOOK. Pointed at a file that already exists it
    // replaces it whole — every sheet the caller did not pass, every formula,
    // every chart, gone, with a success message. An agent that reads a workbook,
    // decides on a change and then "writes it back" through here destroys the
    // file it was asked to edit. So the existing file is the one thing it will
    // not do without being told twice.
    refuse_to_replace(&path, overwrite)?;

    // Built beside the destination, checked, and only then given the name.
    //
    // A write that stops part-way used to leave the half-written file AT the
    // path the user asked for: a workbook whose text all pointed into a
    // zero-byte string table, valid enough to open as a zip and refused by
    // Excel. Writing elsewhere first means a failure costs nothing, and a file
    // that is already there is not destroyed by a write that never finished.
    let temp = format!("{}.jhai-partial", path);
    let _ = std::fs::remove_file(&temp);

    let built = xlsx_edit::without_panicking("write_xlsx", || {
        let mut book = Workbook::new();
        for (i, spec) in sheets.iter().enumerate() {
            let sheet = book.add_worksheet();
            apply_sheet(sheet, spec, preset.as_deref(), i)?;
        }
        book.save(&temp).map_err(|e| format!("Failed to write {}: {}", path, e))
    });
    if let Err(e) = built {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }

    let bytes = std::fs::read(&temp).map_err(|e| format!("Failed to read back {}: {}", temp, e))?;
    if let Err(e) = xlsx_edit::verify_workbook(&bytes) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("{} — {}", path, e));
    }
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to move the finished workbook into place at {}: {}", path, e)
    })?;
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

// ── What an in-place edit costs ─────────────────────────────────────────────

/// Refuse to replace a workbook that already exists.
///
/// Split out from write_xlsx so the rule can be tested without a Tauri State.
fn refuse_to_replace(path: &str, overwrite: Option<bool>) -> Result<(), String> {
    if !std::path::Path::new(path).exists() || overwrite.unwrap_or(false) {
        return Ok(());
    }
    Err(format!(
        "{} already exists. write_xlsx CREATES a workbook: it would replace this file          entirely, and every sheet, formula, chart and format not passed in this call          would be gone.
         
         DO NOT delete the file and create it again — that is the same loss by another          route, and it is what this refusal exists to prevent.
         
         To change cells in an existing workbook, use update_xlsx (or append_xlsx_row to          add a line); both edit in place and keep everything else. If the user really          asked for the file to be REPLACED from scratch, pass overwrite: true on this          same call.",
        path
    ))
}


// ── Editing an existing .xlsx ────────────────────────────────────────────────

/// One cell to change: an A1 address and the value to put there.
#[derive(serde::Deserialize)]
pub struct CellEdit {
    /// Sheet name. Omitted = the first sheet.
    pub sheet: Option<String>,
    /// A1-style address, e.g. "D14".
    pub cell: String,
    /// The value to write. Omitted/undefined leaves the value untouched (style-only edit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// Optional style to apply to this cell, same shape as write_xlsx `styles` entries:
    /// {bold, italic, size, font, color, bg, border, align, valign, numfmt, wrap}.
    /// Merges ONTO the cell's existing style — attributes not named are left as-is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
}

/// Apply cell edits to an EXISTING workbook, in place.
///
/// Nothing here rebuilds the workbook. A value or a formula is written into the
/// worksheet XML and every other part of the package is copied through as bytes;
/// a format is appended to xl/styles.xml and the cell is pointed at the new
/// entry. Charts, pivot tables, macros, images and the formatting of every cell
/// the caller did not name come out exactly as they went in — not because they
/// are handled, but because they are never read.
///
/// Numbers stay numeric so Excel keeps computing on them; a string starting with
/// `=` is written as a FORMULA, because that is unambiguously what it means in a
/// cell. Passing only `style` leaves the contents alone.
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
    let original = std::fs::read(file).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let mut targets = Vec::with_capacity(edits.len());
    let mut restyled = 0usize;
    for (i, edit) in edits.iter().enumerate() {
        let style = match &edit.style {
            Some(v) => {
                let spec = xlsx_stylesheet::StyleSpec::from_json(v)
                    .map_err(|e| format!("edit {}: {}", i, e))?;
                if spec.is_empty() { None } else { Some(spec) }
            }
            None => None,
        };
        if edit.value.is_none() && style.is_none() {
            return Err(format!(
                "edit {}: nothing to do — pass `value` to change the cell, `style` to restyle it,                  or both.",
                i
            ));
        }
        if style.is_some() {
            restyled += 1;
        }

        let write = match &edit.value {
            // Style-only: the contents are left exactly as they are, formula and
            // cached value included.
            None => xlsx_edit::CellWrite::Keep,
            Some(serde_json::Value::Number(n)) => xlsx_edit::CellWrite::Number(n.as_f64().unwrap_or(0.0)),
            Some(serde_json::Value::Bool(b)) => xlsx_edit::CellWrite::Bool(*b),
            Some(serde_json::Value::Null) => xlsx_edit::CellWrite::Clear,
            Some(other) => {
                let text = other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string());
                match text.strip_prefix('=') {
                    Some(f) => xlsx_edit::CellWrite::Formula(f.to_string()),
                    None => xlsx_edit::CellWrite::Text(text),
                }
            }
        };

        let mut target = xlsx_edit::target_from(edit.sheet.clone(), &edit.cell, write)
            .map_err(|e| format!("edit {}: {}", i, e))?;
        target.style = style;
        targets.push(target);
    }

    let out = xlsx_edit::without_panicking("update_xlsx", || {
        let out = xlsx_edit::edit_workbook(&original, &targets)?;
        // Checked BEFORE it replaces the original. An edit that produced a
        // half-written package used to overwrite the workbook it was editing.
        xlsx_edit::verify_workbook(&out)?;
        Ok(out)
    })?;
    std::fs::write(file, &out).map_err(|e| format!("Failed to save {}: {}", path, e))?;

    let styled_note = if restyled > 0 {
        format!(" {} of them restyled, by ADDING to the stylesheet — no existing format was                  changed, so no other cell moved.", restyled)
    } else {
        String::new()
    };
    Ok(format!(
        "Updated {} ({} cell(s)).{} Everything else in the workbook — charts, pivot tables,          macros, images, conditional formatting, and the formatting of every cell not named          here — was copied through untouched.",
        path,
        targets.len(),
        styled_note
    ))
}

/// Add one row to the bottom of a sheet, formatted like the row above it.
///
/// The most common edit anyone makes to a business workbook is "one more line
/// on the 明細", and doing it with plain cell writes gets the values right and
/// the look wrong: a cell that did not exist has no format to inherit, so the
/// new row lands unruled in the middle of a ruled table. This copies the last
/// row's shape — its height, and each column's style index — and drops the
/// values into it.
///
/// `{row}` in a formula is replaced with the number of the row being added, so
/// the caller does not have to know it in advance.
#[tauri::command]
pub async fn append_xlsx_row(
    path: String,
    sheet: Option<String>,
    values: serde_json::Map<String, serde_json::Value>,
    guard: State<'_, PathGuard>,
) -> Result<String, String> {
    guard.ensure_allowed(&path)?;
    let file = std::path::Path::new(&path);
    if !file.exists() {
        return Err(format!("{} does not exist.", path));
    }
    if values.is_empty() {
        return Err("append_xlsx_row requires at least one column value".into());
    }

    let original = std::fs::read(file).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    // The row number is only known after the sheet has been scanned, so the
    // placeholder is resolved in two passes: append once to learn the number,
    // then again with the formulas filled in. Cheap — these files are small —
    // and it keeps the caller from having to guess.
    let build = |row: Option<u32>| -> Result<std::collections::BTreeMap<u32, xlsx_edit::CellWrite>, String> {
        let mut out = std::collections::BTreeMap::new();
        for (col, v) in values.iter() {
            let idx = xlsx_edit::column_index(col)
                .ok_or_else(|| format!("\"{}\" is not a column letter (A, B, AA…)", col))?;
            let write = match v {
                serde_json::Value::Number(n) => xlsx_edit::CellWrite::Number(n.as_f64().unwrap_or(0.0)),
                serde_json::Value::Bool(b) => xlsx_edit::CellWrite::Bool(*b),
                serde_json::Value::Null => xlsx_edit::CellWrite::Clear,
                other => {
                    let text = other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string());
                    match text.strip_prefix('=') {
                        Some(f) => xlsx_edit::CellWrite::Formula(match row {
                            Some(r) => f.replace("{row}", &r.to_string()),
                            None => f.to_string(),
                        }),
                        None => xlsx_edit::CellWrite::Text(text),
                    }
                }
            };
            out.insert(idx, write);
        }
        Ok(out)
    };

    let probe = xlsx_edit::append_row(
        &original,
        &xlsx_edit::RowAppend { sheet: sheet.clone(), values: build(None)? },
    )?;
    let result = xlsx_edit::without_panicking("append_xlsx_row", || {
        let r = xlsx_edit::append_row(
            &original,
            &xlsx_edit::RowAppend { sheet: sheet.clone(), values: build(Some(probe.row))? },
        )?;
        xlsx_edit::verify_workbook(&r.bytes)?;
        Ok(r)
    })?;

    std::fs::write(file, &result.bytes).map_err(|e| format!("Failed to save {}: {}", path, e))?;

    let inherited = if result.inherited {
        format!("Its formatting was copied from row {}.", result.row - 1)
    } else {
        "There was no row above to take formatting from, so it is unformatted.".into()
    };
    Ok(format!(
        "Added row {} to \"{}\". {} NOTE: ranges were NOT extended — a SUM above the new row,          the autofilter and any table range still cover what they covered before. If a total          should include this row, update that formula with update_xlsx.",
        result.row, result.sheet, inherited
    ))
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

    #[test]
    fn a1_to_rc_parses_letters_and_digits() {
        assert_eq!(a1_to_rc("A1"), Some((0, 0)));
        assert_eq!(a1_to_rc("C3"), Some((2, 2)));
        assert_eq!(a1_to_rc("AA10"), Some((9, 26)));
        assert_eq!(a1_to_rc("Z1"), Some((0, 25)));
        assert_eq!(a1_to_rc("1A"), None);
        assert_eq!(a1_to_rc(""), None);
    }

    #[test]
    fn parse_color_accepts_hex_and_names() {
        assert_eq!(parse_color("#FF0000"), Some(0xFF0000));
        assert_eq!(parse_color("FF0000"), Some(0xFF0000));
        assert_eq!(parse_color("red"), Some(0xFF0000));
        assert_eq!(parse_color("lightgray"), Some(0xD3D3D3));
        assert_eq!(parse_color("notacolor"), None);
    }

    #[test]
    fn cell_value_unwraps_plain_and_style_cells() {
        let plain = serde_json::json!("hi");
        let (v, s) = cell_value(&plain);
        assert_eq!(v.as_str().unwrap(), "hi");
        assert!(s.is_none());

        let styled = serde_json::json!({ "v": 42, "style": "total" });
        let (v, s) = cell_value(&styled);
        assert_eq!(v.as_i64().unwrap(), 42);
        assert_eq!(s.unwrap(), "total");
    }

    #[test]
    fn cell_style_builds_a_format_with_fields() {
        let cs = CellStyle::from_value(&serde_json::json!({
            "bold": true,
            "size": 14.0,
            "color": "#FF0000",
            "bg": "yellow",
            "border": "medium",
            "align": "center",
            "numfmt": "#,##0"
        })).unwrap();
        assert!(cs.bold);
        assert_eq!(cs.size, Some(14.0));
        assert_eq!(cs.color.as_deref(), Some("#FF0000"));
        assert_eq!(cs.bg.as_deref(), Some("yellow"));
        assert_eq!(cs.border.as_deref(), Some("medium"));
        assert_eq!(cs.align.as_deref(), Some("center"));
        assert_eq!(cs.numfmt.as_deref(), Some("#,##0"));
        // Building the Format must not panic for any field combination.
        let _ = cs.to_format();
    }

    #[test]
    fn merge_ranges_accepts_a1_and_rowcol_forms() {
        let design = serde_json::json!({
            "merges": [
                { "from": "A1", "to": "C1" },
                { "row": 2, "col": 0, "span": 3 }
            ]
        });
        let ranges = merge_ranges(&design);
        assert_eq!(ranges, vec![(0, 0, 0, 2), (2, 0, 2, 2)]);
    }

    /// End-to-end: write a styled workbook through the same JSON the LLM sends,
    /// then read it back and verify the design actually landed.
    #[test]
    fn write_xlsx_applies_styles_merges_and_widths() {
        use serde_json::json;
        let dir = std::env::temp_dir();
        let path = dir.join(format!("jhai_office_style_{}.xlsx", std::process::id()));

        let spec = SheetSpec {
            name: Some("Sales".to_string()),
            rows: vec![
                vec![json!({ "v": "Quarterly Report", "style": "title" }), json!(""), json!("")],
                vec![json!("Region"), json!("Q1"), json!("Q2")],
                vec![json!("North"), json!(120), json!(135)],
                vec![json!({ "v": "Total", "style": "total" }), json!(255), json!(0)],
            ],
            design: Some(json!({
                "merges": [{ "from": "A1", "to": "C1" }],
                "col_widths": { "A": 20, "B": 12 },
                "header": false,
                "orientation": "landscape"
            })),
            styles: Some(json!({
                "title": { "bold": true, "size": 16, "align": "center" },
                "total": { "bold": true, "bg": "#FFF2CC" }
            })),
        };

        // Replicate write_xlsx's core loop (command itself needs a Tauri state,
        // so exercise the pure parts: style resolution + file round-trip).
        use rust_xlsxwriter::{Format, Workbook};
        let mut book = Workbook::new();
        let header = Format::new().set_bold();
        {
            let sheet = book.add_worksheet();
            let mut styles: std::collections::HashMap<String, Format> = std::collections::HashMap::new();
            if let Some(sv) = spec.styles.as_ref().and_then(serde_json::Value::as_object) {
                for (k, v) in sv {
                    if let Some(cs) = CellStyle::from_value(v) {
                        styles.insert(k.clone(), cs.to_format());
                    }
                }
            }
            let design = spec.design.clone().unwrap_or(serde_json::Value::Null);
            if let Some(ws) = design.get("col_widths").and_then(serde_json::Value::as_object) {
                for (k, v) in ws {
                    if let (Some((_, c)), Some(w)) = (a1_to_rc(&format!("{}1", k)), v.as_f64()) {
                        let _ = sheet.set_column_width(c, w);
                    }
                }
            }
            for (r, row) in spec.rows.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    let (row_i, col_i) = (r as u32, c as u16);
                    let (_, style_name) = cell_value(cell);
                    let use_header = design.get("header").and_then(serde_json::Value::as_bool).unwrap_or(true);
                    let fmt: Option<&Format> = if r == 0 && use_header && style_name.is_none() {
                        Some(&header)
                    } else {
                        style_name.and_then(|n| styles.get(n))
                    };
                    let _ = write_cell(sheet, row_i, col_i, cell, fmt);
                }
            }
            for (r1, c1, r2, c2) in merge_ranges(&design) {
                let _ = sheet.merge_range(r1, c1, r2, c2, "", &Format::default());
                if let Some(row) = spec.rows.get(r1 as usize) {
                    if let Some(cell) = row.get(c1 as usize) {
                        let (_, style_name) = cell_value(cell);
                        let use_header = design.get("header").and_then(serde_json::Value::as_bool).unwrap_or(true);
                        let fmt: Option<&Format> = if r1 == 0 && use_header && style_name.is_none() {
                            Some(&header)
                        } else {
                            style_name.and_then(|n| styles.get(n))
                        };
                        let _ = write_cell(sheet, r1, c1, cell, fmt);
                    }
                }
            }
        }
        book.save(&path).unwrap();

        let doc = read_spreadsheet(std::fs::read(&path).unwrap(), "xlsx", 60_000, None).unwrap();
        assert!(doc.text.contains("Quarterly Report"));
        // The merged title means the trailing cells are empty by design.
        assert!(doc.text.contains("Merged ranges"));

        let _ = std::fs::remove_file(path);
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


#[cfg(test)]
mod preset_tests {
    use super::*;

    fn spec(rows: serde_json::Value, design: Option<serde_json::Value>) -> SheetSpec {
        SheetSpec {
            name: Some("明細".into()),
            rows: serde_json::from_value(rows).unwrap(),
            design,
            styles: None,
        }
    }

    /// The sample the acceptance criterion is about: headers and a few columns,
    /// and NOTHING said about how it should look.
    fn sample() -> serde_json::Value {
        serde_json::json!([
            ["品目", "数量", "単価", "金額", "年", "備考"],
            ["ステンレスねじ M4x10", 120, 25, 3000, 2026,
             "在庫僅少のため次回発注時に数量を見直すこと。納期は通常より一週間ほど余分にかかる。"],
            ["亜鉛メッキ板金 t1.6", 4, 1800, 7200, 2025, "図面Aに準拠"],
            ["エポキシ塗料 2kg", 2, 3200, 6400, 2026, "屋外用"]
        ])
    }

    fn build(preset: Option<&str>, design: Option<serde_json::Value>, out: &str) {
        let mut book = rust_xlsxwriter::Workbook::new();
        let sheet = book.add_worksheet();
        apply_sheet(sheet, &spec(sample(), design), preset, 0).unwrap();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/fidelity");
        let _ = std::fs::create_dir_all(&dir);
        book.save(dir.join(out)).unwrap();
    }

    /// Writes the workbooks scripts/xlsx_preset.py inspects. Column widths,
    /// number formats and print titles are not things this side can check
    /// honestly — rust_xlsxwriter would be confirming its own output — so a
    /// second reader does it. See docs/design/xlsx-fidelity.md §4.
    #[test]
    fn dumps_preset_samples_for_the_python_check() {
        build(None, None, "preset-default.xlsx");
        build(Some("plain"), None, "preset-plain.xlsx");
        build(Some("report"), None, "preset-report.xlsx");
        // An explicit design still wins over the preset.
        build(
            Some("business-ja"),
            Some(serde_json::json!({ "freeze": 0, "col_widths": { "A": 40 } })),
            "preset-override.xlsx",
        );
    }

    /// A workbook that came out of write_xlsx with an EMPTY xl/sharedStrings.xml
    /// — structurally a zip, and refused by Excel and by openpyxl alike.
    ///
    /// Reproduces the shape that produced it: two sheets, Japanese text, a
    /// design carrying col_widths.
    #[test]
    fn a_two_sheet_workbook_has_a_readable_string_table() {
        use std::io::Read;
        let mut book = rust_xlsxwriter::Workbook::new();
        for (i, name) in ["表紙", "詳細"].iter().enumerate() {
            let sheet = book.add_worksheet();
            let spec = SheetSpec {
                name: Some((*name).into()),
                rows: serde_json::from_value(serde_json::json!([
                    ["項目", "内容"],
                    ["目的", "エージェントの詳細設計"],
                    ["範囲", "xlsx 書き込み"]
                ])).unwrap(),
                design: Some(serde_json::json!({ "col_widths": { "A": 18, "B": 60 } })),
                styles: None,
            };
            apply_sheet(sheet, &spec, None, i).unwrap();
        }
        // 21 rows x 4 columns, like the sheet that came out broken.
        {
            let sheet = book.add_worksheet();
            let mut rows = vec![serde_json::json!(["ID", "項目", "説明", "備考"])];
            for i in 1..=20 {
                rows.push(serde_json::json!([
                    i,
                    format!("項目{}", i),
                    format!("この項目の説明文です（{}）", i),
                    "―"
                ]));
            }
            let spec = SheetSpec {
                name: Some("一覧".into()),
                rows: serde_json::from_value(serde_json::Value::Array(rows)).unwrap(),
                design: Some(serde_json::json!({ "col_widths": { "A": 8 } })),
                styles: None,
            };
            apply_sheet(sheet, &spec, None, 2).unwrap();
        }

        let out = std::env::temp_dir().join(format!("two-sheet-{}.xlsx", std::process::id()));
        book.save(&out).unwrap();

        let bytes = std::fs::read(&out).unwrap();
        let _ = std::fs::remove_file(&out);
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut ss = String::new();
        zip.by_name("xl/sharedStrings.xml")
            .expect("no shared string table at all")
            .read_to_string(&mut ss)
            .unwrap();
        assert!(!ss.trim().is_empty(), "xl/sharedStrings.xml is EMPTY — Excel calls that damaged");
        assert!(ss.contains("目的"), "the strings are missing from the table: {}", ss);
    }

    #[test]
    fn a_sheet_with_no_rows_does_not_panic() {
        let mut book = rust_xlsxwriter::Workbook::new();
        let sheet = book.add_worksheet();
        apply_sheet(sheet, &spec(serde_json::json!([]), None), None, 0).unwrap();
    }

    #[test]
    fn ragged_rows_do_not_panic() {
        let mut book = rust_xlsxwriter::Workbook::new();
        let sheet = book.add_worksheet();
        let rows = serde_json::json!([["a", "b", "c"], [1], [1, 2, 3, 4, 5]]);
        apply_sheet(sheet, &spec(rows, None), None, 0).unwrap();
    }
}

#[cfg(test)]
mod overwrite_tests {
    #[test]
    fn creating_over_an_existing_workbook_is_refused() {
        let e = super::refuse_to_replace("tests/fixtures/styled.xlsx", None).unwrap_err();
        assert!(e.contains("update_xlsx"), "the error must name the tool that edits in place");
        assert!(e.contains("overwrite"), "and the way to override it");
    }

    /// The refusal has to close the door it used to leave open.
    ///
    /// Faced with "this file already exists", the agent deleted the file and
    /// created it again — the same loss by another route, arrived at by
    /// reading a message that only said what NOT to pass. So the message now
    /// names the workaround and rules it out.
    #[test]
    fn the_refusal_rules_out_deleting_the_file_instead() {
        let e = super::refuse_to_replace("tests/fixtures/styled.xlsx", None).unwrap_err();
        assert!(e.contains("DO NOT delete the file"), "{}", e);
        assert!(e.contains("update_xlsx"), "{}", e);
        assert!(e.contains("append_xlsx_row"), "{}", e);
    }

    #[test]
    fn a_new_path_is_allowed() {
        assert!(super::refuse_to_replace("tests/fixtures/does-not-exist.xlsx", None).is_ok());
    }

    #[test]
    fn an_explicit_overwrite_is_allowed() {
        assert!(super::refuse_to_replace("tests/fixtures/styled.xlsx", Some(true)).is_ok());
    }
}
