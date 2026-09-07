// xlsx_edit — change cells in a workbook without rebuilding it.
//
// The previous way of editing an .xlsx was: parse the whole package into a
// model, mutate the model, write the model back out. Everything the model does
// not represent is then simply not written. Charts vanished — the part deleted,
// the <graphicFrame> stripped, an empty anchor left behind — and because the
// result is a VALID package, Excel opened it without a word of complaint. The
// same fate waits for pivot tables, slicers, macros, form controls and whatever
// the format grows next: the failure is structural, not a missing feature.
//
// So this does not parse the workbook. It opens the zip, rewrites the XML of
// the worksheets that have edits, and copies every other entry through as
// bytes. A part that is never read cannot be lost.
//
//   xlsx (zip)
//   ├ xl/worksheets/sheet1.xml   ← rewritten, streaming
//   ├ xl/charts/chart1.xml       ┐
//   ├ xl/pivotCache/…            │ copied verbatim
//   ├ xl/media/image1.png        │
//   └ …                         ┘
//
// Two things beyond the cells have to be right, or Excel shows the "repaired"
// dialog and the user's trust is gone either way:
//
//   * xl/calcChain.xml is the cached evaluation ORDER of the formulas. Add a
//     cell and it no longer describes the sheet. It is dropped here (with its
//     content-type override and its relationship); Excel rebuilds it.
//   * A formula written without its cached <v> displays as blank until
//     something recalculates, so workbook.xml gets fullCalcOnLoad.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};

use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};

/// What to put in one cell.
#[derive(Debug, Clone, PartialEq)]
pub enum CellWrite {
    Number(f64),
    Bool(bool),
    Text(String),
    /// Without the leading `=`.
    Formula(String),
    /// Empty the cell, keeping its formatting.
    Clear,
    /// Leave the contents exactly as they are. Used by a style-only edit,
    /// where the cell keeps its value and only its format index changes.
    Keep,
}

/// What to put in one cell, and — for a cell being created — what format to
/// give it.
///
/// `style` is None for an ordinary edit, which means "keep whatever the cell
/// already had". It is Some only when a row is being appended, where the format
/// is copied from the row above.
#[derive(Debug, Clone)]
pub struct CellPlan {
    pub write: CellWrite,
    /// The style INDEX to write, once it is known.
    pub style: Option<String>,
    /// The format the caller asked for, before it has been turned into an
    /// index. Resolved against the stylesheet in edit_workbook.
    pub restyle: Option<crate::commands::xlsx_stylesheet::StyleSpec>,
}

/// One cell to change, already resolved to a sheet and 1-based coordinates.
#[derive(Debug, Clone)]
pub struct Target {
    /// None = the first sheet in the workbook.
    pub sheet: Option<String>,
    pub row: u32,
    pub col: u32,
    pub write: CellWrite,
    /// A format to merge onto whatever the cell already has. None leaves the
    /// formatting alone, which is the usual case.
    pub style: Option<crate::commands::xlsx_stylesheet::StyleSpec>,
}

/// 1-based column index → spreadsheet letters. 1→A, 27→AA.
fn col_letters(mut col: u32) -> String {
    let mut out = Vec::new();
    while col > 0 {
        let rem = ((col - 1) % 26) as u8;
        out.push(b'A' + rem);
        col = (col - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// "D14" → (14, 4), both 1-based. None if it is not an A1 address.
fn parse_a1(s: &str) -> Option<(u32, u32)> {
    let s = s.trim();
    let b = s.as_bytes();
    let mut col = 0u32;
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        col = col * 26 + (b[i].to_ascii_uppercase() - b'A' + 1) as u32;
        i += 1;
    }
    if i == 0 || i == b.len() || col == 0 {
        return None;
    }
    let row: u32 = std::str::from_utf8(&b[i..]).ok()?.parse().ok()?;
    if row == 0 { return None; }
    Some((row, col))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The XML for one cell, carrying forward the style index it already had.
///
/// `s` is the whole point of the surgical approach: the cell keeps the format
/// it was given, so changing a number in a ruled, currency-formatted column
/// leaves it ruled and currency-formatted.
fn cell_xml(row: u32, col: u32, style: Option<&str>, write: &CellWrite) -> String {
    let r = format!("{}{}", col_letters(col), row);
    let s = style.map(|s| format!(" s=\"{}\"", s)).unwrap_or_default();
    match write {
        // Keep is resolved by the rewriter, which has the original element
        // in hand. Reaching here means there was no original, so it is empty.
        CellWrite::Clear | CellWrite::Keep => format!("<c r=\"{}\"{}/>", r, s),
        CellWrite::Number(n) => {
            // {} on f64 gives "3" for 3.0, which is what a spreadsheet wants.
            format!("<c r=\"{}\"{}><v>{}</v></c>", r, s, n)
        }
        CellWrite::Bool(b) => {
            format!("<c r=\"{}\"{} t=\"b\"><v>{}</v></c>", r, s, if *b { 1 } else { 0 })
        }
        // An inline string rather than an entry in xl/sharedStrings.xml: that
        // table is shared by every sheet, so appending to it makes the blast
        // radius of one cell edit the whole workbook. Inline strings are plain
        // OOXML and Excel reads them without complaint.
        CellWrite::Text(t) => format!(
            "<c r=\"{}\"{} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            r, s, esc(t)
        ),
        // No cached <v>: a stale cached value is worse than a blank one, and
        // fullCalcOnLoad makes Excel fill it in on open.
        CellWrite::Formula(f) => format!("<c r=\"{}\"{}><f>{}</f></c>", r, s, esc(f)),
    }
}

/// What a sheet contains that an edit has to respect.
#[derive(Default)]
struct SheetScan {
    /// Merged ranges as (r1, c1, r2, c2), 1-based inclusive.
    merges: Vec<(u32, u32, u32, u32)>,
    /// Cells that OWN a shared formula, and how far it reaches.
    shared_masters: BTreeMap<(u32, u32), String>,
    /// The highest row number present, 0 for an empty sheet.
    last_row: u32,
    /// That row's `<row>` attributes, verbatim — height, custom format, style.
    last_row_attrs: String,
    /// And the style index of each of its cells, by column. This is the
    /// template an appended row is cut from: copy these and the new row is
    /// ruled, aligned and formatted exactly like the one above it.
    last_row_styles: BTreeMap<u32, String>,
    /// The style index of specific cells the caller asked about — the base a
    /// restyle is derived from. Only the requested coordinates are kept: a
    /// whole sheet's worth would be megabytes for no purpose.
    cell_styles: BTreeMap<(u32, u32), String>,
}

/// Read the parts of a sheet that constrain where we may write.
///
/// A pre-pass because both live after `<sheetData>` in the file (mergeCells) or
/// are only recognisable across cells (shared formulas), and the rewrite is a
/// single forward stream.
fn scan_sheet(xml: &str, want_styles: &BTreeSet<(u32, u32)>) -> SheetScan {
    let mut scan = SheetScan::default();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut cur_cell: Option<(u32, u32)> = None;
    let mut cur_row: u32 = 0;
    let mut cur_row_attrs = String::new();
    let mut cur_row_styles: BTreeMap<u32, String> = BTreeMap::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                match local_name(&e).as_str() {
                    "row" => {
                        let r: u32 = attr(&e, "r").and_then(|v| v.parse().ok()).unwrap_or(0);
                        if r >= cur_row {
                            cur_row = r;
                            cur_row_styles = BTreeMap::new();
                            cur_row_attrs = e
                                .attributes()
                                .flatten()
                                .filter(|a| a.key.as_ref() != b"r")
                                .map(|a| {
                                    format!(
                                        " {}=\"{}\"",
                                        String::from_utf8_lossy(a.key.as_ref()),
                                        String::from_utf8_lossy(&a.value)
                                    )
                                })
                                .collect();
                        }
                    }
                    "mergeCell" => {
                        if let Some(r) = attr(&e, "ref") {
                            if let Some((a, b)) = r.split_once(':') {
                                if let (Some(p), Some(q)) = (parse_a1(a), parse_a1(b)) {
                                    scan.merges.push((p.0, p.1, q.0, q.1));
                                }
                            }
                        }
                    }
                    "c" => {
                        cur_cell = attr(&e, "r").as_deref().and_then(parse_a1);
                        if let (Some((r, c)), Some(st)) = (cur_cell, attr(&e, "s")) {
                            if r == cur_row {
                                cur_row_styles.insert(c, st.clone());
                            }
                            if want_styles.contains(&(r, c)) {
                                scan.cell_styles.insert((r, c), st);
                            }
                        }
                    }
                    "f" => {
                        // The master carries t="shared" AND a ref; the followers
                        // carry only si.
                        if attr(&e, "t").as_deref() == Some("shared") {
                            if let (Some(rc), Some(rf)) = (cur_cell, attr(&e, "ref")) {
                                scan.shared_masters.insert(rc, rf);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }
    scan.last_row = cur_row;
    scan.last_row_attrs = cur_row_attrs;
    scan.last_row_styles = cur_row_styles;
    scan
}

fn local_name(e: &BytesStart) -> String {
    let full = String::from_utf8_lossy(e.name().as_ref()).to_string();
    full.rsplit(':').next().unwrap_or(&full).to_string()
}

fn attr(e: &BytesStart, key: &str) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        let name = String::from_utf8_lossy(a.key.as_ref()).to_string();
        let local = name.rsplit(':').next().unwrap_or(&name).to_string();
        if local == key {
            Some(String::from_utf8_lossy(&a.value).to_string())
        } else {
            None
        }
    })
}

/// Rewrite one worksheet, replacing/inserting the given cells.
///
/// Rows must come out in ascending `r`, and cells within a row in ascending
/// column: the schema requires it, and readers that trust the order produce
/// garbage when it is broken.
fn rewrite_sheet(
    xml: &str,
    edits: &BTreeMap<(u32, u32), CellPlan>,
    // Attributes for rows this call creates — the height and custom format
    // copied from the row an append is modelled on, keyed by row number.
    new_row_attrs: &BTreeMap<u32, String>,
) -> Result<String, String> {
    let mut pending: BTreeMap<u32, BTreeMap<u32, CellPlan>> = BTreeMap::new();
    for (&(r, c), plan) in edits {
        pending.entry(r).or_default().insert(c, plan.clone());
    }

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    // Rows we have to emit ourselves, in order, before a given row number.
    macro_rules! emit_row {
        ($row:expr, $cells:expr) => {{
            let attrs = new_row_attrs.get(&$row).cloned().unwrap_or_default();
            let mut s = format!("<row r=\"{}\"{}>", $row, attrs);
            for (col, plan) in $cells.iter() {
                s.push_str(&cell_xml($row, *col, plan.style.as_deref(), &plan.write));
            }
            s.push_str("</row>");
            writer.get_mut().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
        }};
    }

    let mut current_row: u32 = 0;
    let mut row_edits: BTreeMap<u32, CellPlan> = BTreeMap::new();
    let mut skipping_cell_depth: i32 = -1;

    loop {
        let ev = reader.read_event_into(&mut buf).map_err(|e| format!("sheet XML: {}", e))?;
        match ev {
            Event::Eof => break,

            // Inside a <c> we are replacing: swallow everything to its </c>.
            _ if skipping_cell_depth >= 0 => {
                match &ev {
                    Event::Start(_) => skipping_cell_depth += 1,
                    Event::End(_) => {
                        skipping_cell_depth -= 1;
                        if skipping_cell_depth < 0 {
                            skipping_cell_depth = -1;
                        }
                    }
                    _ => {}
                }
                if skipping_cell_depth == 0 {
                    skipping_cell_depth = -1;
                }
                buf.clear();
                continue;
            }

            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = local_name(e);
                let is_empty = matches!(ev, Event::Empty(_));

                if name == "sheetData" && is_empty && !pending.is_empty() {
                    // <sheetData/> — an empty sheet that now needs rows.
                    writer.get_mut().write_all(b"<sheetData>").map_err(|e| e.to_string())?;
                    let rows: Vec<u32> = pending.keys().copied().collect();
                    for r in rows {
                        let cells = pending.remove(&r).unwrap();
                        emit_row!(r, cells);
                    }
                    writer.get_mut().write_all(b"</sheetData>").map_err(|e| e.to_string())?;
                    buf.clear();
                    continue;
                }

                if name == "row" {
                    let r: u32 = attr(e, "r").and_then(|v| v.parse().ok()).unwrap_or(0);
                    // Any wholly new rows that belong before this one.
                    let before: Vec<u32> = pending.range(..r).map(|(k, _)| *k).collect();
                    for br in before {
                        let cells = pending.remove(&br).unwrap();
                        emit_row!(br, cells);
                    }
                    current_row = r;
                    row_edits = pending.remove(&r).unwrap_or_default();

                    if is_empty && !row_edits.is_empty() {
                        // <row r="5"/> that now gets cells: open it properly.
                        let mut open = String::from("<row");
                        for a in e.attributes().flatten() {
                            open.push_str(&format!(
                                " {}=\"{}\"",
                                String::from_utf8_lossy(a.key.as_ref()),
                                String::from_utf8_lossy(&a.value)
                            ));
                        }
                        open.push('>');
                        writer.get_mut().write_all(open.as_bytes()).map_err(|e| e.to_string())?;
                        let cells = std::mem::take(&mut row_edits);
                        for (col, plan) in cells {
                            let s = cell_xml(current_row, col, plan.style.as_deref(), &plan.write);
                            writer.get_mut().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
                        }
                        writer.get_mut().write_all(b"</row>").map_err(|e| e.to_string())?;
                        buf.clear();
                        continue;
                    }

                    writer.write_event(ev.clone()).map_err(|e| e.to_string())?;
                    buf.clear();
                    continue;
                }

                if name == "c" && !row_edits.is_empty() {
                    let (_, col) = attr(e, "r").as_deref().and_then(parse_a1).unwrap_or((0, 0));
                    // New cells that sort before this one.
                    let before: Vec<u32> = row_edits.range(..col).map(|(k, _)| *k).collect();
                    for bc in before {
                        let plan = row_edits.remove(&bc).unwrap();
                        let s = cell_xml(current_row, bc, plan.style.as_deref(), &plan.write);
                        writer.get_mut().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
                    }
                    if let Some(plan) = row_edits.remove(&col) {
                        // Replace it, keeping s= — the cell's formatting — unless
                        // the plan brought one of its own.
                        let style = plan.style.clone().or_else(|| attr(e, "s"));
                        if matches!(plan.write, CellWrite::Keep) {
                            // A style-only edit: the contents stay exactly as
                            // they are, so the opening tag is re-emitted with a
                            // new s= and everything inside passes through
                            // untouched — including a formula and its cached
                            // value, which a rebuild would have had to guess at.
                            let mut open = String::from("<c");
                            for a in e.attributes().flatten() {
                                let k = String::from_utf8_lossy(a.key.as_ref()).to_string();
                                if k == "s" {
                                    continue;
                                }
                                open.push_str(&format!(
                                    " {}=\"{}\"",
                                    k,
                                    String::from_utf8_lossy(&a.value)
                                ));
                            }
                            if let Some(st) = &style {
                                open.push_str(&format!(" s=\"{}\"", st));
                            }
                            open.push_str(if is_empty { "/>" } else { ">" });
                            writer.get_mut().write_all(open.as_bytes()).map_err(|e| e.to_string())?;
                            buf.clear();
                            continue;
                        }
                        let s = cell_xml(current_row, col, style.as_deref(), &plan.write);
                        writer.get_mut().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
                        if !is_empty {
                            skipping_cell_depth = 1;
                        }
                        buf.clear();
                        continue;
                    }
                }

                writer.write_event(ev.clone()).map_err(|e| e.to_string())?;
            }

            Event::End(ref e) => {
                let name = local_name(&BytesStart::new(
                    String::from_utf8_lossy(e.name().as_ref()).to_string(),
                ));
                if name == "row" && !row_edits.is_empty() {
                    let cells = std::mem::take(&mut row_edits);
                    for (col, plan) in cells {
                        let s = cell_xml(current_row, col, plan.style.as_deref(), &plan.write);
                        writer.get_mut().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
                    }
                }
                if name == "sheetData" && !pending.is_empty() {
                    let rows: Vec<u32> = pending.keys().copied().collect();
                    for r in rows {
                        let cells = pending.remove(&r).unwrap();
                        emit_row!(r, cells);
                    }
                }
                writer.write_event(ev.clone()).map_err(|e| e.to_string())?;
            }

            other => {
                writer.write_event(other).map_err(|e| e.to_string())?;
            }
        }
        buf.clear();
    }

    String::from_utf8(writer.into_inner().into_inner()).map_err(|e| e.to_string())
}

/// name → part path, in workbook order.
fn sheet_index(parts: &BTreeMap<String, Vec<u8>>) -> Result<Vec<(String, String)>, String> {
    let wb = parts
        .get("xl/workbook.xml")
        .ok_or("not an xlsx: xl/workbook.xml is missing")?;
    let rels = parts
        .get("xl/_rels/workbook.xml.rels")
        .ok_or("not an xlsx: xl/_rels/workbook.xml.rels is missing")?;

    let mut by_id: BTreeMap<String, String> = BTreeMap::new();
    let rels_xml = String::from_utf8_lossy(rels).to_string();
    let mut reader = Reader::from_str(&rels_xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if local_name(&e) == "Relationship" => {
                if let (Some(id), Some(target)) = (attr(&e, "Id"), attr(&e, "Target")) {
                    let path = if let Some(abs) = target.strip_prefix('/') {
                        abs.to_string()
                    } else {
                        format!("xl/{}", target.trim_start_matches("./"))
                    };
                    by_id.insert(id, path);
                }
            }
            _ => {}
        }
        buf.clear();
    }

    let mut out = Vec::new();
    let wb_xml = String::from_utf8_lossy(wb).to_string();
    let mut reader = Reader::from_str(&wb_xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if local_name(&e) == "sheet" => {
                if let (Some(name), Some(id)) = (attr(&e, "name"), attr(&e, "id")) {
                    if let Some(path) = by_id.get(&id) {
                        out.push((name, path.clone()));
                    }
                }
            }
            _ => {}
        }
        buf.clear();
    }
    if out.is_empty() {
        return Err("the workbook has no sheets".into());
    }
    Ok(out)
}

/// Make Excel recalculate on open, since formulas are written without a cached
/// value.
fn set_full_calc_on_load(workbook_xml: &str) -> String {
    if workbook_xml.contains("fullCalcOnLoad=\"1\"") {
        return workbook_xml.to_string();
    }
    if let Some(i) = workbook_xml.find("<calcPr") {
        let end = workbook_xml[i..].find('>').map(|e| i + e).unwrap_or(i);
        let mut out = workbook_xml.to_string();
        out.insert_str(end, " fullCalcOnLoad=\"1\"");
        return out;
    }
    // No <calcPr> at all: it belongs directly before </workbook>.
    workbook_xml.replace(
        "</workbook>",
        "<calcPr calcId=\"124519\" fullCalcOnLoad=\"1\"/></workbook>",
    )
}

/// Remove a part, its content-type override and any relationship to it.
fn drop_part(parts: &mut BTreeMap<String, Vec<u8>>, order: &mut Vec<String>, path: &str) {
    if parts.remove(path).is_none() {
        return;
    }
    order.retain(|n| n != path);

    if let Some(ct) = parts.get("[Content_Types].xml") {
        let s = String::from_utf8_lossy(ct).to_string();
        let needle = format!("/{}\"", path);
        let cleaned: String = s
            .split("<Override")
            .enumerate()
            .map(|(i, seg)| {
                if i == 0 {
                    seg.to_string()
                } else if seg.contains(&needle) {
                    // Drop this Override, keep whatever followed its `/>`.
                    seg.find("/>").map(|e| seg[e + 2..].to_string()).unwrap_or_default()
                } else {
                    format!("<Override{}", seg)
                }
            })
            .collect();
        parts.insert("[Content_Types].xml".into(), cleaned.into_bytes());
    }

    let rel_name = path.rsplit('/').next().unwrap_or(path).to_string();
    if let Some(rels) = parts.get("xl/_rels/workbook.xml.rels") {
        let s = String::from_utf8_lossy(rels).to_string();
        let cleaned: String = s
            .split("<Relationship")
            .enumerate()
            .map(|(i, seg)| {
                if i == 0 {
                    seg.to_string()
                } else if seg.contains(&format!("Target=\"{}\"", rel_name))
                    || seg.contains(&format!("Target=\"/{}\"", path))
                {
                    seg.find("/>").map(|e| seg[e + 2..].to_string()).unwrap_or_default()
                } else {
                    format!("<Relationship{}", seg)
                }
            })
            .collect();
        parts.insert("xl/_rels/workbook.xml.rels".into(), cleaned.into_bytes());
    }
}

/// Apply cell edits to a workbook, returning the new package.
///
/// Everything not named by an edit is copied through untouched — including the
/// parts this code has never heard of.
pub fn edit_workbook(bytes: &[u8], targets: &[Target]) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("not a readable .xlsx: {}", e))?;

    let mut parts: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let mut b = Vec::new();
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        order.push(name.clone());
        parts.insert(name, b);
    }

    let sheets = sheet_index(&parts)?;
    let first = sheets[0].0.clone();

    // Group by sheet path, reporting an unknown sheet with the real names
    // rather than an empty result.
    let mut by_sheet: BTreeMap<String, BTreeMap<(u32, u32), CellPlan>> = BTreeMap::new();
    let mut wrote_formula = false;
    for t in targets {
        let want = t.sheet.clone().unwrap_or_else(|| first.clone());
        let path = sheets
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(&want))
            .map(|(_, p)| p.clone())
            .ok_or_else(|| {
                format!(
                    "no sheet named \"{}\". Available sheets: {}",
                    want,
                    sheets.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ")
                )
            })?;
        if matches!(t.write, CellWrite::Formula(_)) {
            wrote_formula = true;
        }
        by_sheet
            .entry(path)
            .or_default()
            .insert((t.row, t.col), CellPlan {
                write: t.write.clone(),
                style: None,
                restyle: t.style.clone(),
            });
    }

    // Restyles are derived from the format each cell already has, so the scan
    // is told which cells to remember the style of.
    let mut want_styles: BTreeMap<String, BTreeSet<(u32, u32)>> = BTreeMap::new();
    for (path, edits) in &by_sheet {
        let set: BTreeSet<(u32, u32)> = edits
            .iter()
            .filter(|(_, p)| p.restyle.is_some())
            .map(|(k, _)| *k)
            .collect();
        want_styles.insert(path.clone(), set);
    }
    let restyling = want_styles.values().any(|s| !s.is_empty());
    let mut stylesheet = if restyling {
        let xml = parts
            .get("xl/styles.xml")
            .map(|b| String::from_utf8_lossy(b).to_string())
            .ok_or("the workbook has no xl/styles.xml to add a format to")?;
        Some(crate::commands::xlsx_stylesheet::Stylesheet::parse(&xml)?)
    } else {
        None
    };

    for (path, edits) in &mut by_sheet {
        let xml = parts
            .get(path)
            .map(|b| String::from_utf8_lossy(b).to_string())
            .ok_or_else(|| format!("the workbook references {} but it is not in the file", path))?;

        let scan = scan_sheet(&xml, want_styles.get(path).unwrap_or(&BTreeSet::new()));

        // Derive the new format indices before the sheet is rewritten, so the
        // rewrite only has to write a number.
        if let Some(sheetstyles) = stylesheet.as_mut() {
            for (&(row, col), plan) in edits.iter_mut() {
                let Some(spec) = plan.restyle.clone() else { continue };
                let base = scan
                    .cell_styles
                    .get(&(row, col))
                    .and_then(|s| s.parse::<u32>().ok());
                plan.style = Some(sheetstyles.derive(base, &spec)?.to_string());
            }
        }

        for &(row, col) in edits.keys() {
            // Writing inside a merged range puts a value where Excel will not
            // show it: the range displays only its top-left cell.
            if let Some(&(r1, c1, r2, c2)) = scan.merges.iter().find(|&&(r1, c1, r2, c2)| {
                row >= r1 && row <= r2 && col >= c1 && col <= c2 && !(row == r1 && col == c1)
            }) {
                return Err(format!(
                    "{}{} is inside the merged range {}{}:{}{} — a value written there is \
                     invisible in Excel, which shows only the top-left cell. Write to {}{} instead.",
                    col_letters(col), row,
                    col_letters(c1), r1, col_letters(c2), r2,
                    col_letters(c1), r1
                ));
            }
            // A shared formula lives once, in its master cell; the rest of the
            // range points at it by index. Overwriting the master silently
            // empties every cell that followed it.
            if let Some(range) = scan.shared_masters.get(&(row, col)) {
                return Err(format!(
                    "{}{} owns the shared formula filled across {} — overwriting it would blank \
                     every other cell in that range. Rewrite the whole range cell by cell, or \
                     edit it in Excel.",
                    col_letters(col), row, range
                ));
            }
        }

        let out = rewrite_sheet(&xml, edits, &BTreeMap::new())?;
        parts.insert(path.clone(), out.into_bytes());
    }

    if let Some(sheetstyles) = stylesheet {
        parts.insert("xl/styles.xml".into(), sheetstyles.into_xml().into_bytes());
    }

    // The cached calculation order no longer describes the sheet.
    drop_part(&mut parts, &mut order, "xl/calcChain.xml");

    if wrote_formula {
        if let Some(wb) = parts.get("xl/workbook.xml") {
            let s = set_full_calc_on_load(&String::from_utf8_lossy(wb));
            parts.insert("xl/workbook.xml".into(), s.into_bytes());
        }
    }

    let mut out = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut out));
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for name in &order {
            let Some(data) = parts.get(name) else { continue };
            zw.start_file(name, opts).map_err(|e| format!("zip {}: {}", name, e))?;
            zw.write_all(data).map_err(|e| format!("write {}: {}", name, e))?;
        }
        zw.finish().map_err(|e| format!("finalising the .xlsx: {}", e))?;
    }
    Ok(out)
}

/// One row to add at the bottom of a sheet, taking its formatting from the row
/// above.
pub struct RowAppend {
    /// None = the first sheet.
    pub sheet: Option<String>,
    /// Column letter → what to put there. Columns the template row has but this
    /// map does not are written empty, so the ruling continues across the row.
    pub values: BTreeMap<u32, CellWrite>,
}

/// What an append did, so the caller can say it plainly.
pub struct AppendResult {
    pub bytes: Vec<u8>,
    pub sheet: String,
    pub row: u32,
    /// True when the new row inherited a format from the row above.
    pub inherited: bool,
}

/// Append a row to the bottom of a sheet, copying the format of the last row.
///
/// This is the edit people actually make to a business workbook: one more line
/// on the 明細. Doing it as plain cell writes produces a row with no ruling, no
/// number format and no alignment — technically the right values, visibly a
/// mistake — because a brand-new cell has no style index to inherit. So the row
/// above is used as the pattern: its `<row>` attributes and each of its cells'
/// style indices are copied, and the values are dropped into that shape.
///
/// What this does NOT do is move ranges. A `SUM(D2:D11)` above the new row does
/// not become `SUM(D2:D12)`, the autofilter still covers the old range, and a
/// table's range is unchanged. Excel would extend some of those; matching it
/// needs a formula parser, and a range extended wrongly is worse than one left
/// alone. The caller is told, in the result, so the total can be fixed with an
/// ordinary cell edit.
pub fn append_row(bytes: &[u8], append: &RowAppend) -> Result<AppendResult, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("not a readable .xlsx: {}", e))?;
    let mut parts: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let mut b = Vec::new();
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        order.push(name.clone());
        parts.insert(name, b);
    }

    let sheets = sheet_index(&parts)?;
    let want = append.sheet.clone().unwrap_or_else(|| sheets[0].0.clone());
    let (name, path) = sheets
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(&want))
        .cloned()
        .ok_or_else(|| {
            format!(
                "no sheet named \"{}\". Available sheets: {}",
                want,
                sheets.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ")
            )
        })?;

    let xml = parts
        .get(&path)
        .map(|b| String::from_utf8_lossy(b).to_string())
        .ok_or_else(|| format!("the workbook references {} but it is not in the file", path))?;
    let scan = scan_sheet(&xml, &BTreeSet::new());
    let row = scan.last_row + 1;

    // Every column the template row had, plus every column being written.
    let mut cols: Vec<u32> = scan.last_row_styles.keys().copied().collect();
    for c in append.values.keys() {
        if !cols.contains(c) {
            cols.push(*c);
        }
    }
    cols.sort_unstable();

    let mut plans: BTreeMap<(u32, u32), CellPlan> = BTreeMap::new();
    for c in cols {
        let write = append.values.get(&c).cloned().unwrap_or(CellWrite::Clear);
        plans.insert(
            (row, c),
            CellPlan { write, style: scan.last_row_styles.get(&c).cloned(), restyle: None },
        );
    }
    if plans.is_empty() {
        return Err("nothing to append: pass at least one value".into());
    }

    let mut attrs = BTreeMap::new();
    if !scan.last_row_attrs.is_empty() {
        attrs.insert(row, scan.last_row_attrs.clone());
    }

    let out = rewrite_sheet(&xml, &plans, &attrs)?;
    parts.insert(path.clone(), out.into_bytes());
    drop_part(&mut parts, &mut order, "xl/calcChain.xml");
    if append.values.values().any(|w| matches!(w, CellWrite::Formula(_))) {
        if let Some(wb) = parts.get("xl/workbook.xml") {
            let s = set_full_calc_on_load(&String::from_utf8_lossy(wb));
            parts.insert("xl/workbook.xml".into(), s.into_bytes());
        }
    }

    let mut out_bytes = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut out_bytes));
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for n in &order {
            let Some(data) = parts.get(n) else { continue };
            zw.start_file(n, opts).map_err(|e| format!("zip {}: {}", n, e))?;
            zw.write_all(data).map_err(|e| format!("write {}: {}", n, e))?;
        }
        zw.finish().map_err(|e| format!("finalising the .xlsx: {}", e))?;
    }

    Ok(AppendResult {
        bytes: out_bytes,
        sheet: name,
        row,
        inherited: !scan.last_row_styles.is_empty(),
    })
}

/// "C" → 3. Used for the column keys of an append.
pub fn column_index(letters: &str) -> Option<u32> {
    parse_a1(&format!("{}1", letters.trim())).map(|(_, c)| c)
}

/// Is this a workbook Excel will open, or one it will call damaged?
///
/// Written after a `write_xlsx` produced a file with 140 cells referring to
/// entries in a `xl/sharedStrings.xml` that was zero bytes long, and with two
/// parts that `[Content_Types].xml` promised and the archive did not contain.
/// It still opened as a zip — a panic unwinding through the writer drops the
/// ZipWriter, whose `Drop` finalises the archive around whatever had been
/// written so far — so nothing downstream noticed, and what reached the user
/// was a file Excel refuses.
///
/// The check is deliberately structural rather than semantic: it asks whether
/// the package says it contains things it does not, which is what a half-written
/// file looks like from the outside.
pub fn verify_workbook(bytes: &[u8]) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("the result is not a readable zip: {}", e))?;

    let mut sizes: BTreeMap<String, u64> = BTreeMap::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        if !f.is_dir() {
            sizes.insert(f.name().to_string(), f.size());
        }
    }

    let mut content_types = String::new();
    zip.by_name("[Content_Types].xml")
        .map_err(|_| "the result has no [Content_Types].xml".to_string())?
        .read_to_string(&mut content_types)
        .map_err(|e| e.to_string())?;

    let mut missing = Vec::new();
    let mut empty = Vec::new();
    for seg in content_types.split("PartName=\"/").skip(1) {
        let Some(name) = seg.split('"').next() else { continue };
        match sizes.get(name) {
            None => missing.push(name.to_string()),
            Some(0) => empty.push(name.to_string()),
            Some(_) => {}
        }
    }

    // A cell with t="s" is an index into the shared string table. An empty table
    // means every piece of text in the workbook points at nothing.
    let mut needs_strings = false;
    for name in sizes.keys().cloned().collect::<Vec<_>>() {
        if !name.starts_with("xl/worksheets/") || !name.ends_with(".xml") {
            continue;
        }
        let mut xml = String::new();
        if zip.by_name(&name).map(|mut f| f.read_to_string(&mut xml)).is_ok() && xml.contains("t=\"s\"") {
            needs_strings = true;
            break;
        }
    }
    if needs_strings && sizes.get("xl/sharedStrings.xml").copied().unwrap_or(0) == 0 {
        empty.push("xl/sharedStrings.xml".into());
    }

    if missing.is_empty() && empty.is_empty() {
        return Ok(());
    }
    let mut why = Vec::new();
    if !missing.is_empty() {
        why.push(format!("宣言されているのに存在しない: {}", missing.join(", ")));
    }
    if !empty.is_empty() {
        why.push(format!("空: {}", empty.join(", ")));
    }
    Err(format!(
        "the workbook that was produced is incomplete and Excel would refuse it ({}).          It has NOT been saved. This means the write stopped part-way rather than failing          outright.",
        why.join(" / ")
    ))
}

/// Run a build that might panic, and turn a panic into an error.
///
/// A panic inside a Tauri command never sends a response, so the `await` on the
/// JavaScript side never settles: the step sits at "Writing spreadsheet…" for
/// ever, with no error anywhere. That is not a hang to debug later — it is a
/// crash that has been made invisible. Catching it costs nothing and turns the
/// same event into a message naming where it happened.
pub fn without_panicking<T>(what: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => {
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "(no message)".into());
            Err(format!(
                "{} crashed: {}. Nothing was written. Please report this with the arguments                  that produced it.",
                what, msg
            ))
        }
    }
}

/// Turn an A1 address into a Target, or say why it is not one.
pub fn target_from(
    sheet: Option<String>,
    addr: &str,
    write: CellWrite,
) -> Result<Target, String> {
    let (row, col) = parse_a1(addr)
        .ok_or_else(|| format!("\"{}\" is not an A1 address (expected something like D14)", addr))?;
    Ok(Target { sheet, row, col, write, style: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plain-edit form of rewrite_sheet: no inherited styles, no new row
    /// attributes. Appending is the only caller that needs those.
    fn rw(xml: &str, edits: &BTreeMap<(u32, u32), CellWrite>) -> Result<String, String> {
        let plans = edits
            .iter()
            .map(|(k, w)| (*k, CellPlan { write: w.clone(), style: None, restyle: None }))
            .collect();
        rewrite_sheet(xml, &plans, &BTreeMap::new())
    }

    #[test]
    fn a1_addresses_round_trip() {
        assert_eq!(parse_a1("A1"), Some((1, 1)));
        assert_eq!(parse_a1("D14"), Some((14, 4)));
        assert_eq!(parse_a1("AA100"), Some((100, 27)));
        assert_eq!(parse_a1("a1"), Some((1, 1)));
        assert_eq!(parse_a1("1A"), None);
        assert_eq!(parse_a1("A"), None);
        assert_eq!(parse_a1("A0"), None);
        for c in [1u32, 26, 27, 52, 53, 702, 703] {
            assert_eq!(parse_a1(&format!("{}1", col_letters(c))).unwrap().1, c);
        }
    }

    /// The style index is what makes an edit inherit the cell's formatting.
    #[test]
    fn a_replaced_cell_keeps_its_style_index() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1" s="7" t="s"><v>3</v></c></row></sheetData></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((1, 1), CellWrite::Number(42.0));
        let out = rw(xml, &edits).unwrap();
        assert!(out.contains(r#"<c r="A1" s="7"><v>42</v></c>"#), "{}", out);
        assert!(!out.contains("t=\"s\""), "the old shared-string marker survived: {}", out);
    }

    #[test]
    fn a_new_cell_lands_in_column_order() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((1, 2), CellWrite::Text("b".into()));
        let out = rw(xml, &edits).unwrap();
        let a = out.find("r=\"A1\"").unwrap();
        let b = out.find("r=\"B1\"").unwrap();
        let c = out.find("r=\"C1\"").unwrap();
        assert!(a < b && b < c, "cells out of order: {}", out);
    }

    #[test]
    fn a_new_row_lands_in_row_order() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((2, 1), CellWrite::Number(2.0));
        let out = rw(xml, &edits).unwrap();
        let r1 = out.find("r=\"1\"").unwrap();
        let r2 = out.find("r=\"2\"").unwrap();
        let r3 = out.find("r=\"3\"").unwrap();
        assert!(r1 < r2 && r2 < r3, "rows out of order: {}", out);
    }

    #[test]
    fn a_row_after_the_last_one_is_appended() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((9, 2), CellWrite::Text("late".into()));
        let out = rw(xml, &edits).unwrap();
        assert!(out.contains(r#"<row r="9">"#), "{}", out);
        assert!(out.find("<row r=\"9\">").unwrap() < out.find("</sheetData>").unwrap());
    }

    #[test]
    fn an_empty_sheet_gains_a_sheet_data_body() {
        let xml = r#"<worksheet><sheetData/></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((1, 1), CellWrite::Text("hi".into()));
        let out = rw(xml, &edits).unwrap();
        assert!(out.contains("<sheetData><row r=\"1\">"), "{}", out);
        assert!(out.contains("</sheetData>"), "{}", out);
    }

    /// A formula must not carry the previous cached result, and a text value
    /// must not be escaped into something Excel reads as markup.
    #[test]
    fn a_formula_drops_the_cached_value() {
        let xml = r#"<worksheet><sheetData><row r="2"><c r="D2" s="3"><f>B2*C2</f><v>250</v></c></row></sheetData></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((2, 4), CellWrite::Formula("B2*C2*1.1".into()));
        let out = rw(xml, &edits).unwrap();
        assert!(out.contains("<f>B2*C2*1.1</f>"), "{}", out);
        assert!(!out.contains("<v>250</v>"), "the stale cached value survived: {}", out);
    }

    #[test]
    fn text_is_escaped() {
        let mut edits = BTreeMap::new();
        edits.insert((1, 1), CellWrite::Text("a & b <c>".into()));
        let out = rw(
            r#"<worksheet><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>"#,
            &edits,
        )
        .unwrap();
        assert!(out.contains("a &amp; b &lt;c&gt;"), "{}", out);
    }

    #[test]
    fn everything_else_in_the_sheet_is_untouched() {
        let xml = r#"<worksheet><sheetPr/><dimension ref="A1:D9"/><sheetViews><sheetView><pane ySplit="1"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><conditionalFormatting sqref="B2:B9"><cfRule type="cellIs"/></conditionalFormatting><mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells><pageSetup paperSize="9"/></worksheet>"#;
        let mut edits = BTreeMap::new();
        edits.insert((1, 1), CellWrite::Number(2.0));
        let out = rw(xml, &edits).unwrap();
        for keep in ["<pane ySplit=\"1\"", "conditionalFormatting", "mergeCell ref=\"A5:C5\"",
                     "pageSetup paperSize=\"9\"", "dimension ref=\"A1:D9\""] {
            assert!(out.contains(keep), "{} was lost: {}", keep, out);
        }
    }

    // ── Against real workbooks ─────────────────────────────────────────────
    //
    // The unit tests above use hand-written XML, which is exactly the material
    // that hides this class of bug: it contains only what the author thought
    // of. These run against files openpyxl produced, and check the property
    // that matters — that an edit changes the cells it names and NOTHING else
    // in the package.

    fn fixture(name: &str) -> Vec<u8> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {}", p.display(), e))
    }

    fn part_names(bytes: &[u8]) -> Vec<String> {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        let mut v: Vec<String> = (0..z.len())
            .filter_map(|i| z.by_index(i).ok().map(|f| f.name().to_string()))
            .collect();
        v.sort();
        v
    }

    fn part_bytes(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).ok()?;
        let mut f = z.by_name(name).ok()?;
        let mut b = Vec::new();
        f.read_to_end(&mut b).ok()?;
        Some(b)
    }

    /// The whole point. A chart used to be deleted by any edit, quietly, in a
    /// file that still opened normally.
    #[test]
    fn a_chart_survives_an_edit() {
        let before = fixture("rich.xlsx");
        assert!(part_names(&before).iter().any(|n| n.starts_with("xl/charts/")),
                "the fixture is supposed to have a chart");

        let after = edit_workbook(
            &before,
            &[target_from(Some("明細".into()), "B2", CellWrite::Number(99.0)).unwrap()],
        )
        .unwrap();

        assert_eq!(part_names(&before), part_names(&after), "a package part was lost");
        assert_eq!(
            part_bytes(&before, "xl/charts/chart1.xml"),
            part_bytes(&after, "xl/charts/chart1.xml"),
            "the chart changed"
        );
        let drawing = String::from_utf8_lossy(
            &part_bytes(&after, "xl/drawings/drawing1.xml").unwrap()).to_string();
        assert!(drawing.contains("graphicFrame"), "the chart's anchor lost its frame");
    }

    /// Everything the old engine happened to keep must still be kept, and the
    /// sheets nobody named must come out byte-identical.
    #[test]
    fn untouched_parts_come_out_byte_identical() {
        let before = fixture("rich.xlsx");
        let after = edit_workbook(
            &before,
            &[target_from(Some("明細".into()), "B2", CellWrite::Number(99.0)).unwrap()],
        )
        .unwrap();

        for name in ["xl/styles.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml",
                     "xl/tables/table1.xml", "xl/comments/comment1.xml"] {
            assert_eq!(part_bytes(&before, name), part_bytes(&after, name),
                       "{} was rewritten", name);
        }
    }

    #[test]
    fn the_edit_actually_lands_and_the_neighbours_do_not_move() {
        let before = fixture("styled.xlsx");
        let after = edit_workbook(
            &before,
            &[target_from(None, "B2", CellWrite::Number(99.0)).unwrap()],
        )
        .unwrap();
        let sheet = String::from_utf8_lossy(
            &part_bytes(&after, "xl/worksheets/sheet1.xml").unwrap()).to_string();
        assert!(sheet.contains("<v>99</v>"), "{}", sheet);
        // The neighbouring formula and its formatting are still there.
        assert!(sheet.contains("<f>B2*25</f>"), "the formula next door was disturbed: {}", sheet);
    }

    /// A value written into a merged range is invisible in Excel, so it is
    /// refused rather than written where nobody will see it.
    #[test]
    fn writing_inside_a_merged_range_is_refused() {
        let before = fixture("styled.xlsx");
        let e = edit_workbook(
            &before,
            &[target_from(None, "B5", CellWrite::Text("x".into())).unwrap()],
        )
        .unwrap_err();
        assert!(e.contains("A5:C5"), "{}", e);
        assert!(e.contains("A5"), "the error should name the cell to use instead: {}", e);
    }

    #[test]
    fn an_unknown_sheet_lists_the_real_ones() {
        let e = edit_workbook(
            &fixture("rich.xlsx"),
            &[target_from(Some("ないシート".into()), "A1", CellWrite::Number(1.0)).unwrap()],
        )
        .unwrap_err();
        assert!(e.contains("明細") && e.contains("集計") && e.contains("表"), "{}", e);
    }

    // ── A half-written workbook ────────────────────────────────────────────
    //
    // These are built from the actual broken file: 140 cells pointing into a
    // zero-byte string table, and two parts [Content_Types].xml promised that
    // the archive did not contain. It opened as a zip and Excel refused it.

    /// Drop a part entirely, leaving [Content_Types] still promising it.
    fn drop_entry(bytes: &[u8], target: &str) -> Vec<u8> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        let mut out = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut out));
            let opts: zip::write::SimpleFileOptions = Default::default();
            for i in 0..zip.len() {
                let mut f = zip.by_index(i).unwrap();
                let name = f.name().to_string();
                if name == target {
                    continue;
                }
                let mut b = Vec::new();
                f.read_to_end(&mut b).unwrap();
                zw.start_file(&name, opts).unwrap();
                zw.write_all(&b).unwrap();
            }
            zw.finish().unwrap();
        }
        out
    }

    #[test]
    fn a_whole_workbook_passes_verification() {
        for f in ["styled.xlsx", "rich.xlsx", "ledger.xlsx"] {
            verify_workbook(&fixture(f)).unwrap_or_else(|e| panic!("{}: {}", f, e));
        }
    }

    /// The exact shape of the file that reached the user.
    /// Built by hand rather than from a fixture: the fixtures come from
    /// openpyxl, which writes its text inline and has no string table to empty.
    /// The file that reached the user came from rust_xlsxwriter, which uses one.
    fn package(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut out));
            let opts: zip::write::SimpleFileOptions = Default::default();
            for (name, body) in parts {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(body.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        out
    }

    const CT: &str = r#"<Types><Override PartName="/xl/workbook.xml"/><Override PartName="/xl/worksheets/sheet1.xml"/><Override PartName="/xl/sharedStrings.xml"/></Types>"#;
    const SHEET_WITH_SHARED: &str = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>"#;

    #[test]
    fn an_empty_string_table_is_caught() {
        let broken = package(&[
            ("[Content_Types].xml", CT),
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/worksheets/sheet1.xml", SHEET_WITH_SHARED),
            ("xl/sharedStrings.xml", ""),
        ]);
        // It still opens as a zip, which is why nothing downstream noticed.
        assert!(zip::ZipArchive::new(Cursor::new(broken.clone())).is_ok());
        let e = verify_workbook(&broken).unwrap_err();
        assert!(e.contains("sharedStrings"), "{}", e);
        assert!(e.contains("NOT been saved"), "{}", e);
    }

    #[test]
    fn a_filled_string_table_passes() {
        let ok = package(&[
            ("[Content_Types].xml", CT),
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/worksheets/sheet1.xml", SHEET_WITH_SHARED),
            ("xl/sharedStrings.xml", "<sst><si><t>項目</t></si></sst>"),
        ]);
        verify_workbook(&ok).unwrap();
    }

    #[test]
    fn a_promised_but_absent_part_is_caught() {
        let broken = drop_entry(&fixture("rich.xlsx"), "docProps/core.xml");
        let e = verify_workbook(&broken).unwrap_err();
        assert!(e.contains("docProps/core.xml"), "{}", e);
    }

    #[test]
    fn something_that_is_not_a_workbook_at_all_is_caught() {
        assert!(verify_workbook(b"not a zip").is_err());
    }

    /// A panic must come back as a message, not as a promise that never
    /// settles. In a Tauri command an uncaught panic sends no response at all,
    /// and the step waits for ever with nothing to show.
    #[test]
    fn a_panic_becomes_an_error() {
        let e = without_panicking("write_xlsx", || -> Result<(), String> {
            panic!("index out of bounds: the len is 3 but the index is 7")
        })
        .unwrap_err();
        assert!(e.contains("write_xlsx crashed"), "{}", e);
        assert!(e.contains("index out of bounds"), "the panic message is what identifies it: {}", e);
        assert!(e.contains("Nothing was written"), "{}", e);
    }

    #[test]
    fn an_ordinary_error_passes_straight_through() {
        let e = without_panicking("x", || -> Result<(), String> { Err("plain".into()) }).unwrap_err();
        assert_eq!(e, "plain");
    }

    // ── Restyling ──────────────────────────────────────────────────────────

    fn restyle(name: &str, sheet: &str, addr: &str, spec: crate::commands::xlsx_stylesheet::StyleSpec)
        -> (Vec<u8>, Vec<u8>)
    {
        let before = fixture(name);
        let mut t = target_from(Some(sheet.into()), addr, CellWrite::Keep).unwrap();
        t.style = Some(spec);
        let after = edit_workbook(&before, &[t]).unwrap();
        (before, after)
    }

    /// The last place an edit could still destroy a workbook. Changing a format
    /// used to mean rebuilding the file, which deleted the chart on the way.
    #[test]
    fn a_restyle_keeps_the_chart() {
        let spec = crate::commands::xlsx_stylesheet::StyleSpec {
            bg: Some("#FFFF00".into()), ..Default::default()
        };
        let (before, after) = restyle("rich.xlsx", "明細", "B2", spec);
        assert_eq!(part_names(&before), part_names(&after), "a part was lost");
        assert_eq!(part_bytes(&before, "xl/charts/chart1.xml"),
                   part_bytes(&after, "xl/charts/chart1.xml"));
    }

    /// A style-only edit must not disturb the contents — including a formula and
    /// the value Excel cached for it.
    #[test]
    fn a_restyle_leaves_the_value_alone() {
        let spec = crate::commands::xlsx_stylesheet::StyleSpec {
            bold: Some(true), ..Default::default()
        };
        let (_, after) = restyle("rich.xlsx", "明細", "D2", spec);
        let sheet = String::from_utf8_lossy(
            &part_bytes(&after, "xl/worksheets/sheet1.xml").unwrap()).to_string();
        assert!(sheet.contains("<f>B2*C2</f>"), "the formula was rewritten: {}", sheet);
    }

    /// The stylesheet may only GROW. An entry edited in place would restyle
    /// every other cell pointing at it — the bug that erased every border in a
    /// file and reported success.
    #[test]
    fn a_restyle_only_appends_to_the_stylesheet() {
        let spec = crate::commands::xlsx_stylesheet::StyleSpec {
            bg: Some("#FFFF00".into()), ..Default::default()
        };
        let (before, after) = restyle("styled.xlsx", "明細", "A2", spec);
        let old = String::from_utf8_lossy(&part_bytes(&before, "xl/styles.xml").unwrap()).to_string();
        let new = String::from_utf8_lossy(&part_bytes(&after, "xl/styles.xml").unwrap()).to_string();
        assert!(new.len() > old.len(), "nothing was added");
        // Every fill that was there is still there, spelled the same way.
        for fill in old.split("<fill>").skip(1) {
            let body = fill.split("</fill>").next().unwrap();
            assert!(new.contains(body), "an existing fill was rewritten: {}", body);
        }
    }

    // ── Appending a row ────────────────────────────────────────────────────

    fn append_to(name: &str, values: &[(&str, CellWrite)]) -> (Vec<u8>, AppendResult) {
        let before = fixture(name);
        let mut map = BTreeMap::new();
        for (col, w) in values {
            map.insert(column_index(col).unwrap(), w.clone());
        }
        let r = append_row(&before, &RowAppend { sheet: None, values: map }).unwrap();
        (before, r)
    }

    /// A new row written as plain cells has no style index, so it comes out
    /// unruled and unformatted in the middle of a ruled table — right values,
    /// visibly wrong. The row above is the pattern.
    #[test]
    fn an_appended_row_inherits_the_row_above() {
        let (_, r) = append_to("ledger.xlsx", &[
            ("A", CellWrite::Text("ワッシャー".into())),
            ("B", CellWrite::Number(50.0)),
            ("C", CellWrite::Number(12.0)),
            ("D", CellWrite::Formula("B5*C5".into())),
        ]);
        assert_eq!(r.row, 5, "the ledger has four rows, so the new one is the fifth");
        assert!(r.inherited);

        let sheet = String::from_utf8_lossy(
            &part_bytes(&r.bytes, "xl/worksheets/sheet1.xml").unwrap()).to_string();
        // Every cell of the new row carries a style index, and it is the one the
        // cell above it had.
        let row4: Vec<&str> = ["A4", "B4", "C4", "D4"].iter()
            .map(|a| style_of(&sheet, a).expect("row 4 is styled")).collect();
        let row5: Vec<&str> = ["A5", "B5", "C5", "D5"].iter()
            .map(|a| style_of(&sheet, a).expect("row 5 lost its formatting")).collect();
        assert_eq!(row4, row5);
    }

    /// Values still land, and a formula is still a formula.
    #[test]
    fn an_appended_row_carries_its_values() {
        let (_, r) = append_to("ledger.xlsx", &[
            ("A", CellWrite::Text("ワッシャー".into())),
            ("D", CellWrite::Formula("B5*C5".into())),
        ]);
        let sheet = String::from_utf8_lossy(
            &part_bytes(&r.bytes, "xl/worksheets/sheet1.xml").unwrap()).to_string();
        assert!(sheet.contains("ワッシャー"), "{}", sheet);
        assert!(sheet.contains("<f>B5*C5</f>"), "{}", sheet);
    }

    /// Columns the template row had but this append did not fill still get a
    /// cell, or the ruling stops halfway across the new row.
    #[test]
    fn the_ruling_continues_across_unfilled_columns() {
        let (_, r) = append_to("ledger.xlsx", &[("A", CellWrite::Text("ワッシャー".into()))]);
        let sheet = String::from_utf8_lossy(
            &part_bytes(&r.bytes, "xl/worksheets/sheet1.xml").unwrap()).to_string();
        for addr in ["B5", "C5", "D5"] {
            assert!(style_of(&sheet, addr).is_some(), "{} has no cell at all: {}", addr, sheet);
        }
    }

    /// Row height and any custom row format come from the same template.
    #[test]
    fn the_row_attributes_come_from_the_template_too() {
        let (_, r) = append_to("ledger.xlsx", &[("A", CellWrite::Text("x".into()))]);
        let sheet = String::from_utf8_lossy(
            &part_bytes(&r.bytes, "xl/worksheets/sheet1.xml").unwrap()).to_string();
        let row5 = sheet.split("<row r=\"5\"").nth(1).unwrap_or("");
        assert!(row5.starts_with(" ht=") || row5.contains("ht=\"22"),
                "the new row did not take the height of the one above: {}",
                &row5[..row5.len().min(80)]);
    }

    /// Appending must not disturb the rest of the package any more than an edit
    /// does.
    #[test]
    fn appending_keeps_the_rest_of_the_workbook() {
        let before = fixture("rich.xlsx");
        let mut values = BTreeMap::new();
        values.insert(column_index("A").unwrap(), CellWrite::Text("追記".into()));
        let r = append_row(&before, &RowAppend { sheet: Some("明細".into()), values }).unwrap();
        assert_eq!(part_names(&before), part_names(&r.bytes));
        assert_eq!(part_bytes(&before, "xl/charts/chart1.xml"),
                   part_bytes(&r.bytes, "xl/charts/chart1.xml"));
        assert_eq!(part_bytes(&before, "xl/styles.xml"),
                   part_bytes(&r.bytes, "xl/styles.xml"),
                   "appending should not need a new style");
    }

    /// The style index of a cell in the serialized sheet, or None if the cell
    /// is absent or unstyled.
    fn style_of<'a>(sheet: &'a str, addr: &str) -> Option<&'a str> {
        let at = sheet.find(&format!("r=\"{}\"", addr))?;
        let rest = &sheet[at..];
        let end = rest.find('>')?;
        let tag = &rest[..end];
        let s = tag.find("s=\"")?;
        let after = &tag[s + 3..];
        let close = after.find('"')?;
        Some(&after[..close])
    }

    /// Write a before/after pair for the cross-language check.
    ///
    /// Per-cell FORMATTING equality is the one property this code cannot check
    /// honestly by itself: it would be comparing its own output against its own
    /// idea of what the format is, and a mistaken idea passes both sides. So a
    /// second implementation reads them — openpyxl, in scripts/xlsx_fidelity.py,
    /// run by `npm run test:xlsx`. This test exists to hand it the files.
    #[test]
    fn dumps_a_pair_for_the_python_check() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/fidelity");
        let _ = std::fs::create_dir_all(&dir);
        // A restyle. Whether ONE cell changed colour or every cell sharing its
        // format did is the question, and this side cannot answer it — it would
        // be checking that it wrote the index it meant to write.
        {
            let before = fixture("styled.xlsx");
            let mut t = target_from(Some("明細".into()), "A2", CellWrite::Keep).unwrap();
            t.style = Some(crate::commands::xlsx_stylesheet::StyleSpec {
                bg: Some("#FFFF00".into()),
                bold: Some(true),
                ..Default::default()
            });
            let after = edit_workbook(&before, &[t]).unwrap();
            std::fs::write(dir.join("restyle-before.xlsx"), &before).unwrap();
            std::fs::write(dir.join("restyle-after.xlsx"), &after).unwrap();
        }

        // The appended row, for the same reason: whether row 5 really looks
        // like row 4 is a judgement about formatting, and this side cannot
        // make it without grading its own homework.
        {
            let before = fixture("ledger.xlsx");
            let mut values = BTreeMap::new();
            values.insert(column_index("A").unwrap(), CellWrite::Text("ワッシャー".into()));
            values.insert(column_index("B").unwrap(), CellWrite::Number(50.0));
            values.insert(column_index("C").unwrap(), CellWrite::Number(12.0));
            values.insert(column_index("D").unwrap(), CellWrite::Formula("B5*C5".into()));
            let r = append_row(&before, &RowAppend { sheet: None, values }).unwrap();
            std::fs::write(dir.join("ledger-before.xlsx"), &before).unwrap();
            std::fs::write(dir.join("ledger-appended.xlsx"), &r.bytes).unwrap();
        }

        let cases: [(&str, &str, CellWrite); 2] = [
            ("styled.xlsx", "B2", CellWrite::Number(99.0)),
            // A string goes in as an inline string rather than through the
            // shared table; this is where that gets read back by something
            // other than us.
            ("rich.xlsx", "A2", CellWrite::Text("ボルト M4".into())),
        ];
        for (name, addr, write) in cases {
            let before = fixture(name);
            let after = edit_workbook(
                &before,
                &[target_from(Some("明細".into()), addr, write).unwrap()],
            )
            .unwrap();
            let stem = name.trim_end_matches(".xlsx");
            std::fs::write(dir.join(format!("{}-before.xlsx", stem)), &before).unwrap();
            std::fs::write(dir.join(format!("{}-after.xlsx", stem)), &after).unwrap();
        }
    }

    /// calcChain caches the evaluation ORDER; once cells move it describes a
    /// sheet that no longer exists and Excel offers to repair the file.
    #[test]
    fn the_stale_calc_chain_is_dropped() {
        let before = fixture("rich.xlsx");
        let after = edit_workbook(
            &before,
            &[target_from(Some("明細".into()), "D6", CellWrite::Formula("SUM(D2:D5)".into())).unwrap()],
        )
        .unwrap();
        assert!(!part_names(&after).iter().any(|n| n == "xl/calcChain.xml"));
        let ct = String::from_utf8_lossy(&part_bytes(&after, "[Content_Types].xml").unwrap()).to_string();
        assert!(!ct.contains("calcChain"), "the content-type override outlived the part");
        let wb = String::from_utf8_lossy(&part_bytes(&after, "xl/workbook.xml").unwrap()).to_string();
        assert!(wb.contains("fullCalcOnLoad"), "a formula without a cached value shows blank");
    }

    #[test]
    fn full_calc_on_load_is_set_either_way() {
        assert!(set_full_calc_on_load("<workbook><calcPr calcId=\"1\"/></workbook>")
            .contains("fullCalcOnLoad=\"1\""));
        assert!(set_full_calc_on_load("<workbook><sheets/></workbook>")
            .contains("fullCalcOnLoad=\"1\""));
        // Idempotent: running twice must not stack attributes.
        let once = set_full_calc_on_load("<workbook><calcPr calcId=\"1\"/></workbook>");
        assert_eq!(once, set_full_calc_on_load(&once));
    }
}
