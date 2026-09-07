// xlsx_inspect — tell the agent what a sheet LOOKS like, not just what it says.
//
// read_office returns values. That is enough to answer a question about the
// data and useless for changing the file in keeping with itself: asked to add a
// column or restyle a total, the model had to invent a format out of nothing,
// because it had never been shown the one already in use. Output that does not
// match the sheet around it was the predictable result.
//
// So this is the other half of "既存書式を踏襲する". §2.1 makes a new row inherit
// the row above; this makes the existing formatting legible, so the model can
// ask for "the same as C5" — or simply see that amounts in this workbook are
// #,##0"円" and right-aligned.
//
// It summarises BY COLUMN and BY REGION, never cell by cell. A 40-row sheet has
// 240 cells and about six formats; printing 240 lines would bury the answer and
// fill the context window with repetition. People describe spreadsheets the
// same way — "the amount column is currency, the header is the blue band" — and
// that is the shape a model can act on.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use crate::commands::xlsx_stylesheet::{CellFormat, Stylesheet};

/// One column's prevailing format.
struct ColumnLook {
    letter: String,
    header: Option<String>,
    format: CellFormat,
}

fn col_letters(mut col: u32) -> String {
    let mut out = Vec::new();
    while col > 0 {
        out.push(b'A' + ((col - 1) % 26) as u8);
        col = (col - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn parse_a1(s: &str) -> Option<(u32, u32)> {
    let b = s.trim().as_bytes();
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
    Some((row, col))
}

fn attr(tag: &str, key: &str) -> Option<String> {
    let needle = format!("{}=\"", key);
    let mut from = 0;
    while let Some(rel) = tag[from..].find(&needle) {
        let at = from + rel;
        // A namespace prefix counts as a boundary: the relationship id is
        // written r:id="rId1", and requiring whitespace before the name made
        // every sheet unreachable.
        let prev = if at == 0 { b' ' } else { tag.as_bytes()[at - 1] };
        if prev.is_ascii_whitespace() || prev == b':' {
            let start = at + needle.len();
            let end = tag[start..].find('"')? + start;
            return Some(tag[start..end].to_string());
        }
        from = at + needle.len();
    }
    None
}

/// Every `<tag …>` opening (or self-closing) element in the XML.
fn tags<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{}", name);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = xml[from..].find(&open) {
        let at = from + rel;
        let after = xml[at + open.len()..].chars().next().unwrap_or(' ');
        if after.is_alphanumeric() {
            from = at + open.len();
            continue;
        }
        match xml[at..].find('>') {
            Some(e) => {
                out.push(&xml[at..=at + e]);
                from = at + e + 1;
            }
            None => break,
        }
    }
    out
}

/// The cells of one sheet as (row, col) → style index.
fn cell_styles(sheet_xml: &str) -> BTreeMap<(u32, u32), u32> {
    let mut styles = BTreeMap::new();
    for c in tags(sheet_xml, "c") {
        let Some(r) = attr(c, "r").as_deref().and_then(parse_a1) else { continue };
        if let Some(s) = attr(c, "s").and_then(|v| v.parse::<u32>().ok()) {
            styles.insert(r, s);
        }
    }
    styles
}

/// The header text of each column, read from the first row.
///
/// Values may be inline or in the shared string table, so both are resolved —
/// a header that comes back as "0" because it was an index into sharedStrings
/// is worse than no header at all.
fn header_row(sheet_xml: &str, shared: &[String]) -> BTreeMap<u32, String> {
    let mut out = BTreeMap::new();
    let Some(body) = sheet_xml.split("<sheetData>").nth(1) else { return out };
    let Some(first) = body.split("<row ").nth(1) else { return out };
    let first = first.split("</row>").next().unwrap_or("");
    let mut rest = first;
    while let Some(at) = rest.find("<c ") {
        let tail = &rest[at..];
        let Some(gt) = tail.find('>') else { break };
        let tag = &tail[..=gt];
        let Some((row, col)) = attr(tag, "r").as_deref().and_then(parse_a1) else {
            rest = &tail[gt + 1..];
            continue;
        };
        if row != 1 {
            rest = &tail[gt + 1..];
            continue;
        }
        let body = tail.split("</c>").next().unwrap_or("");
        let t = attr(tag, "t").unwrap_or_default();
        let text = if t == "inlineStr" {
            body.split("<t").nth(1)
                .and_then(|s| s.split_once('>'))
                .map(|(_, r)| r.split("</t>").next().unwrap_or("").to_string())
        } else {
            body.split("<v>").nth(1).and_then(|s| s.split("</v>").next()).map(|v| {
                if t == "s" {
                    v.parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_else(|| v.to_string())
                } else {
                    v.to_string()
                }
            })
        };
        if let Some(txt) = text {
            let txt = txt.trim();
            if !txt.is_empty() {
                out.insert(col, txt.to_string());
            }
        }
        rest = &tail[gt + 1..];
    }
    out
}

fn shared_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    for si in xml.split("<si>").skip(1) {
        let body = si.split("</si>").next().unwrap_or("");
        // A rich-text run is split across several <t>; joining them back is what
        // the cell actually shows.
        let joined: String = body
            .split("<t")
            .skip(1)
            .filter_map(|s| s.split_once('>').map(|(_, r)| r.split("</t>").next().unwrap_or("")))
            .collect();
        out.push(joined);
    }
    out
}

/// Human-readable summary of a sheet's formatting.
pub fn describe(bytes: &[u8], want_sheet: Option<&str>) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("not a readable .xlsx: {}", e))?;
    let mut parts: BTreeMap<String, String> = BTreeMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        if !(name.ends_with(".xml") || name.ends_with(".rels")) {
            continue;
        }
        let mut s = String::new();
        if f.read_to_string(&mut s).is_ok() {
            parts.insert(name, s);
        }
    }

    let styles = parts
        .get("xl/styles.xml")
        .map(|x| Stylesheet::parse(x))
        .transpose()?;
    let shared = parts.get("xl/sharedStrings.xml").map(|x| shared_strings(x)).unwrap_or_default();

    // name → part path, in workbook order.
    let wb = parts.get("xl/workbook.xml").ok_or("not an xlsx: xl/workbook.xml is missing")?;
    let rels = parts.get("xl/_rels/workbook.xml.rels").ok_or("not an xlsx: workbook rels missing")?;
    let mut by_id = BTreeMap::new();
    for r in tags(rels, "Relationship") {
        if let (Some(id), Some(t)) = (attr(r, "Id"), attr(r, "Target")) {
            let path = if let Some(a) = t.strip_prefix('/') { a.to_string() } else { format!("xl/{}", t.trim_start_matches("./")) };
            by_id.insert(id, path);
        }
    }

    let mut out = String::new();
    for s in tags(wb, "sheet") {
        let (Some(name), Some(id)) = (attr(s, "name"), attr(s, "id")) else { continue };
        if let Some(want) = want_sheet {
            if !name.eq_ignore_ascii_case(want) {
                continue;
            }
        }
        let Some(path) = by_id.get(&id) else { continue };
        let Some(xml) = parts.get(path) else { continue };
        out.push_str(&describe_sheet(&name, xml, styles.as_ref(), &shared));
    }
    if out.is_empty() {
        return Err("no sheet matched".into());
    }
    Ok(out)
}

fn describe_sheet(
    name: &str,
    xml: &str,
    styles: Option<&Stylesheet>,
    shared: &[String],
) -> String {
    let dim = tags(xml, "dimension").first().and_then(|t| attr(t, "ref")).unwrap_or_default();
    let mut out = format!("### シート \"{}\"{}\n", name, if dim.is_empty() { String::new() } else { format!("  {}", dim) });

    let headers = header_row(xml, shared);
    let cells = cell_styles(xml);

    // The prevailing format of each column, taken from the DATA rows: row 1 is
    // the header band and would describe every column as "bold on blue".
    let mut per_col: BTreeMap<u32, BTreeMap<u32, usize>> = BTreeMap::new();
    for (&(row, col), &s) in &cells {
        if row == 1 {
            continue;
        }
        *per_col.entry(col).or_default().entry(s).or_insert(0) += 1;
    }

    let mut looks: Vec<ColumnLook> = Vec::new();
    for (col, counts) in &per_col {
        let Some((&idx, _)) = counts.iter().max_by_key(|(_, n)| **n) else { continue };
        let fmt = match styles {
            Some(st) => st.describe(idx),
            None => CellFormat::default(),
        };
        looks.push(ColumnLook {
            letter: col_letters(*col),
            header: headers.get(col).cloned(),
            format: fmt,
        });
    }

    if !looks.is_empty() {
        out.push_str("- 列書式: ");
        let parts: Vec<String> = looks
            .iter()
            .map(|l| {
                let head = l.header.as_deref().unwrap_or("");
                let desc = l.format.describe();
                if head.is_empty() {
                    format!("{}: {}", l.letter, desc)
                } else {
                    format!("{}（{}）: {}", l.letter, head, desc)
                }
            })
            .collect();
        out.push_str(&parts.join(" / "));
        out.push('\n');
    }

    // The header band itself, described once.
    if let (Some(st), Some(&idx)) = (styles, cells.get(&(1, 1))) {
        let f = st.describe(idx);
        out.push_str(&format!("- 見出し行: 1行目 — {}\n", f.describe()));
    }

    let widths: Vec<String> = tags(xml, "col")
        .iter()
        .filter_map(|t| {
            let min = attr(t, "min")?.parse::<u32>().ok()?;
            let max = attr(t, "max")?.parse::<u32>().ok()?;
            let w = attr(t, "width")?;
            let w: f64 = w.parse().ok()?;
            Some(if min == max {
                format!("{}={:.1}", col_letters(min), w)
            } else {
                format!("{}:{}={:.1}", col_letters(min), col_letters(max), w)
            })
        })
        .collect();
    if !widths.is_empty() {
        out.push_str(&format!("- 列幅: {}\n", widths.join(" ")));
    }

    let merges: Vec<String> = tags(xml, "mergeCell").iter().filter_map(|t| attr(t, "ref")).collect();
    if !merges.is_empty() {
        out.push_str(&format!("- 結合: {}\n", merges.join(" ")));
    }

    if let Some(pane) = tags(xml, "pane").first() {
        let y = attr(pane, "ySplit").unwrap_or_default();
        let x = attr(pane, "xSplit").unwrap_or_default();
        let mut bits = Vec::new();
        if y != "" && y != "0" { bits.push(format!("上{}行", y)); }
        if x != "" && x != "0" { bits.push(format!("左{}列", x)); }
        if !bits.is_empty() {
            out.push_str(&format!("- ウィンドウ枠固定: {}\n", bits.join("・")));
        }
    }

    if let Some(af) = tags(xml, "autoFilter").first().and_then(|t| attr(t, "ref")) {
        out.push_str(&format!("- オートフィルタ: {}\n", af));
    }

    let cf: Vec<String> = tags(xml, "conditionalFormatting").iter().filter_map(|t| attr(t, "sqref")).collect();
    if !cf.is_empty() {
        out.push_str(&format!("- 条件付き書式: {}\n", cf.join(" ")));
    }

    let dv: Vec<String> = tags(xml, "dataValidation").iter().filter_map(|t| attr(t, "sqref")).collect();
    if !dv.is_empty() {
        out.push_str(&format!("- 入力規則: {}\n", dv.join(" ")));
    }

    // Things an edit is refused for. Better said here than discovered by a
    // rejected call.
    let shared_formulas: Vec<String> = tags(xml, "f")
        .iter()
        .filter(|t| attr(t, "t").as_deref() == Some("shared"))
        .filter_map(|t| attr(t, "ref"))
        .collect();
    if !shared_formulas.is_empty() {
        out.push_str(&format!(
            "- 共有数式（先頭セルは上書き不可）: {}\n",
            shared_formulas.join(" ")
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
        std::fs::read(p).unwrap()
    }

    #[test]
    fn describes_the_columns_by_their_headers() {
        let out = describe(&fixture("ledger.xlsx"), None).unwrap();
        assert!(out.contains("シート \"明細\""), "{}", out);
        assert!(out.contains("品目"), "{}", out);
        assert!(out.contains("金額"), "{}", out);
        // The currency format the sheet actually uses has to be visible, or the
        // model cannot match it.
        assert!(out.contains("#,##0"), "{}", out);
    }

    #[test]
    fn reports_the_regions_that_constrain_an_edit() {
        let out = describe(&fixture("rich.xlsx"), Some("明細")).unwrap();
        assert!(out.contains("結合: A9:D9"), "{}", out);
        assert!(out.contains("ウィンドウ枠固定"), "{}", out);
        assert!(out.contains("オートフィルタ: A1:D4"), "{}", out);
        assert!(out.contains("条件付き書式"), "{}", out);
        assert!(out.contains("入力規則"), "{}", out);
    }

    #[test]
    fn describes_the_header_band() {
        let out = describe(&fixture("ledger.xlsx"), None).unwrap();
        assert!(out.contains("見出し行"), "{}", out);
        assert!(out.contains("太字"), "{}", out);
    }

    #[test]
    fn one_sheet_can_be_asked_for() {
        let all = describe(&fixture("rich.xlsx"), None).unwrap();
        let one = describe(&fixture("rich.xlsx"), Some("集計")).unwrap();
        assert!(all.contains("集計") && all.contains("明細"));
        assert!(one.contains("集計") && !one.contains("シート \"明細\""), "{}", one);
    }

    #[test]
    fn an_unknown_sheet_is_an_error_not_an_empty_answer() {
        assert!(describe(&fixture("rich.xlsx"), Some("ない")).is_err());
    }
}
