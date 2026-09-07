// xlsx_stylesheet — give a cell a new format without disturbing any other.
//
// This is the last place an edit could still destroy a workbook. Changing a
// cell's value is surgery on one worksheet (see xlsx_edit); changing its FORMAT
// means adding to xl/styles.xml, and the only implementation available for that
// was "parse the whole workbook and write it back", which deletes charts and
// pivot tables on the way past.
//
// The rule that makes this safe is one line long: **append only**. A cell's
// format is an index into a shared pool — dozens of cells point at the same
// entry — so editing an entry in place restyles all of them. That is exactly
// the bug that made every border in a file disappear. So nothing here is ever
// modified: a new font/fill/border/xf is derived from the old one, appended,
// and the cell is pointed at the new index. Existing entries are read and never
// written.
//
// The blocks are spliced back into the original XML rather than the file being
// regenerated, for the same reason as everywhere else in this area: dxfs,
// cellStyles, tableStyles, colors and anything else in there is carried through
// because it is never parsed.

use std::collections::BTreeMap;

/// The style attributes a caller can ask for. All optional: absent means "leave
/// whatever the cell already had", which is what makes this a merge rather than
/// a replacement.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct StyleSpec {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub size: Option<f64>,
    pub font: Option<String>,
    /// Font colour, "#RRGGBB" or "RRGGBB".
    pub color: Option<String>,
    /// Background fill.
    pub bg: Option<String>,
    /// "thin" | "medium" | "thick", applied to all four sides.
    pub border: Option<String>,
    pub align: Option<String>,
    pub valign: Option<String>,
    pub numfmt: Option<String>,
    pub wrap: Option<bool>,
}

impl StyleSpec {
    pub fn is_empty(&self) -> bool {
        *self == StyleSpec::default()
    }

    /// Parse the JSON shape the tools accept. Unknown keys are ignored rather
    /// than rejected — a model that invents `underline` should still get the
    /// bold it also asked for.
    pub fn from_json(v: &serde_json::Value) -> Result<Self, String> {
        let obj = v.as_object().ok_or("style must be an object")?;
        let s = |k: &str| obj.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
        let b = |k: &str| obj.get(k).and_then(serde_json::Value::as_bool);
        Ok(StyleSpec {
            bold: b("bold"),
            italic: b("italic"),
            size: obj.get("size").and_then(serde_json::Value::as_f64),
            font: s("font"),
            color: s("color"),
            bg: s("bg"),
            border: s("border"),
            align: s("align"),
            valign: s("valign"),
            numfmt: s("numfmt"),
            wrap: b("wrap"),
        })
    }
}

/// "#4472C4" / "4472C4" → "FF4472C4", the ARGB form styles.xml uses.
fn argb(c: &str) -> Option<String> {
    let t = c.trim().trim_start_matches('#');
    if t.len() == 6 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("FF{}", t.to_uppercase()))
    } else if t.len() == 8 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(t.to_uppercase())
    } else {
        None
    }
}

/// The contents of one `<x count="n"> … </x>` block: the raw XML of each child.
fn split_children(block: &str, child: &str) -> Vec<String> {
    let open = format!("<{}", child);
    let close = format!("</{}>", child);
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(start) = rest.find(&open) {
        // Guard against matching <fill> when looking for <fills>' children by
        // requiring the next char to end the name.
        let after = rest[start + open.len()..].chars().next().unwrap_or(' ');
        if after.is_alphanumeric() {
            rest = &rest[start + open.len()..];
            continue;
        }
        let tail = &rest[start..];
        // Self-closing?
        let gt = match tail.find('>') {
            Some(g) => g,
            None => break,
        };
        if tail[..gt].ends_with('/') {
            out.push(tail[..=gt].to_string());
            rest = &tail[gt + 1..];
        } else {
            match tail.find(&close) {
                Some(e) => {
                    out.push(tail[..e + close.len()].to_string());
                    rest = &tail[e + close.len()..];
                }
                None => break,
            }
        }
    }
    out
}

/// Locate `<name …>…</name>` (or `<name/>`) in the stylesheet.
fn find_block<'a>(xml: &'a str, name: &str) -> Option<(usize, usize, &'a str)> {
    let open = format!("<{}", name);
    let start = xml.find(&open)?;
    let gt = xml[start..].find('>')? + start;
    if xml[start..=gt].ends_with("/>") {
        return Some((start, gt + 1, ""));
    }
    let close = format!("</{}>", name);
    let end = xml[gt..].find(&close)? + gt + close.len();
    Some((start, end, &xml[gt + 1..end - close.len()]))
}

/// What one style index actually means, for showing to a reader.
///
/// The point of describing a format is that the agent can MATCH it. So this
/// says what a person would say — "#,##0円 右寄せ 細罫" — rather than listing
/// every attribute of the underlying record.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct CellFormat {
    pub numfmt: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub font_color: Option<String>,
    pub fill: Option<String>,
    pub border: Option<String>,
    pub halign: Option<String>,
    pub valign: Option<String>,
    pub wrap: bool,
}

impl CellFormat {
    pub fn describe(&self) -> String {
        let mut bits: Vec<String> = Vec::new();
        bits.push(self.numfmt.clone().unwrap_or_else(|| "標準".into()));
        if self.bold { bits.push("太字".into()); }
        if self.italic { bits.push("斜体".into()); }
        if let Some(c) = &self.font_color { bits.push(format!("文字{}", short_color(c))); }
        if let Some(c) = &self.fill { bits.push(format!("塗り{}", short_color(c))); }
        if let Some(b) = &self.border { bits.push(format!("{}罫", jp_border(b))); }
        match self.halign.as_deref() {
            Some("center") => bits.push("中央".into()),
            Some("right") => bits.push("右寄せ".into()),
            Some("left") => bits.push("左寄せ".into()),
            _ => {}
        }
        if self.valign.as_deref() == Some("center") { bits.push("上下中央".into()); }
        if self.wrap { bits.push("折返し".into()); }
        bits.join(" ")
    }
}

fn short_color(argb: &str) -> String {
    // The alpha byte is noise for a human reading a summary.
    if argb.len() == 8 { format!("#{}", &argb[2..]) } else { format!("#{}", argb) }
}

fn jp_border(style: &str) -> &str {
    match style {
        "medium" => "中太",
        "thick" => "太",
        "double" => "二重",
        "dashed" | "dotted" => "破線",
        _ => "細",
    }
}

/// The number formats Excel knows without being told. Only the ones a business
/// sheet actually uses are named; the rest come back as their id, which is still
/// more useful than nothing.
fn builtin_numfmt(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => return None,
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        14 => "yyyy/mm/dd",
        18 | 19 | 20 | 21 => "h:mm",
        22 => "yyyy/mm/dd h:mm",
        38 | 39 | 40 => "#,##0;[Red]-#,##0",
        176..=180 => "（ユーザー定義）",
        _ => return None,
    })
}

/// An editable view of xl/styles.xml.
pub struct Stylesheet {
    xml: String,
    fonts: Vec<String>,
    fills: Vec<String>,
    borders: Vec<String>,
    xfs: Vec<String>,
    /// Custom number formats: code → id.
    numfmts: BTreeMap<String, u32>,
    next_numfmt_id: u32,
}

const DEFAULT_XF: &str = "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>";

impl Stylesheet {
    pub fn parse(xml: &str) -> Result<Self, String> {
        let get = |name: &str, child: &str| -> Vec<String> {
            find_block(xml, name)
                .map(|(_, _, inner)| split_children(inner, child))
                .unwrap_or_default()
        };
        let mut numfmts = BTreeMap::new();
        let mut next = 164u32;
        if let Some((_, _, inner)) = find_block(xml, "numFmts") {
            for f in split_children(inner, "numFmt") {
                if let (Some(id), Some(code)) = (attr_of(&f, "numFmtId"), attr_of(&f, "formatCode")) {
                    if let Ok(n) = id.parse::<u32>() {
                        next = next.max(n + 1);
                        numfmts.insert(unescape(&code), n);
                    }
                }
            }
        }
        let xfs = find_block(xml, "cellXfs")
            .map(|(_, _, inner)| split_children(inner, "xf"))
            .unwrap_or_else(|| vec![DEFAULT_XF.to_string()]);

        Ok(Stylesheet {
            xml: xml.to_string(),
            fonts: get("fonts", "font"),
            fills: get("fills", "fill"),
            borders: get("borders", "border"),
            xfs,
            numfmts,
            next_numfmt_id: next,
        })
    }

    /// What the style at `idx` looks like.
    pub fn describe(&self, idx: u32) -> CellFormat {
        let Some(xf) = self.xfs.get(idx as usize) else { return CellFormat::default() };
        let id = |k: &str| attr_of(xf, k).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        let font = self.fonts.get(id("fontId") as usize).cloned().unwrap_or_default();
        let fill = self.fills.get(id("fillId") as usize).cloned().unwrap_or_default();
        let border = self.borders.get(id("borderId") as usize).cloned().unwrap_or_default();
        let align = element_of(xf, "alignment").unwrap_or_default();

        let numfmt_id = id("numFmtId");
        let numfmt = self
            .numfmts
            .iter()
            .find(|(_, v)| **v == numfmt_id)
            .map(|(k, _)| k.clone())
            .or_else(|| builtin_numfmt(numfmt_id).map(str::to_string));

        CellFormat {
            numfmt,
            bold: font.contains("<b/>") || font.contains("<b "),
            italic: font.contains("<i/>") || font.contains("<i "),
            font_color: element_of(&font, "color").and_then(|c| attr_of(&c, "rgb")),
            fill: if fill.contains("patternType=\"solid\"") {
                element_of(&fill, "fgColor").and_then(|c| attr_of(&c, "rgb"))
            } else {
                None
            },
            border: element_of(&border, "left").and_then(|s| attr_of(&s, "style")),
            halign: attr_of(&align, "horizontal"),
            valign: attr_of(&align, "vertical"),
            wrap: attr_of(&align, "wrapText").map(|v| v == "1").unwrap_or(false),
        }
    }

    fn push_unique(pool: &mut Vec<String>, item: String) -> u32 {
        if let Some(i) = pool.iter().position(|x| *x == item) {
            return i as u32;
        }
        pool.push(item);
        (pool.len() - 1) as u32
    }

    /// Derive a style index for a cell that currently has `base`, applying the
    /// spec on top of it. Nothing existing is modified.
    pub fn derive(&mut self, base: Option<u32>, spec: &StyleSpec) -> Result<u32, String> {
        let xf = base
            .and_then(|i| self.xfs.get(i as usize).cloned())
            .unwrap_or_else(|| DEFAULT_XF.to_string());

        let font_id: u32 = attr_of(&xf, "fontId").and_then(|v| v.parse().ok()).unwrap_or(0);
        let fill_id: u32 = attr_of(&xf, "fillId").and_then(|v| v.parse().ok()).unwrap_or(0);
        let border_id: u32 = attr_of(&xf, "borderId").and_then(|v| v.parse().ok()).unwrap_or(0);
        let numfmt_id: u32 = attr_of(&xf, "numFmtId").and_then(|v| v.parse().ok()).unwrap_or(0);

        // ── font ────────────────────────────────────────────────────────────
        let new_font_id = if spec.bold.is_some() || spec.italic.is_some() || spec.size.is_some()
            || spec.font.is_some() || spec.color.is_some()
        {
            let old = self.fonts.get(font_id as usize).cloned().unwrap_or_else(|| "<font/>".into());
            let built = derive_font(&old, spec);
            Self::push_unique(&mut self.fonts, built)
        } else {
            font_id
        };

        // ── fill ────────────────────────────────────────────────────────────
        let new_fill_id = match spec.bg.as_deref().and_then(argb) {
            Some(rgb) => {
                // A solid fill paints its fgColor. bgColor is the second colour
                // of a hatch and is ignored when the pattern is solid.
                let built = format!(
                    "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"{}\"/><bgColor indexed=\"64\"/></patternFill></fill>",
                    rgb
                );
                Self::push_unique(&mut self.fills, built)
            }
            None => fill_id,
        };

        // ── border ──────────────────────────────────────────────────────────
        let new_border_id = match spec.border.as_deref() {
            Some(style) => {
                let s = match style {
                    "medium" => "medium",
                    "thick" => "thick",
                    "none" => "",
                    _ => "thin",
                };
                let side = |n: &str| {
                    if s.is_empty() {
                        format!("<{}/>", n)
                    } else {
                        format!("<{} style=\"{}\"/>", n, s)
                    }
                };
                let built = format!(
                    "<border>{}{}{}{}<diagonal/></border>",
                    side("left"), side("right"), side("top"), side("bottom")
                );
                Self::push_unique(&mut self.borders, built)
            }
            None => border_id,
        };

        // ── number format ───────────────────────────────────────────────────
        let new_numfmt_id = match spec.numfmt.as_deref() {
            Some(code) => match self.numfmts.get(code) {
                Some(id) => *id,
                None => {
                    let id = self.next_numfmt_id;
                    self.next_numfmt_id += 1;
                    self.numfmts.insert(code.to_string(), id);
                    id
                }
            },
            None => numfmt_id,
        };

        // ── alignment ───────────────────────────────────────────────────────
        let old_align = element_of(&xf, "alignment");
        let horizontal = spec
            .align
            .as_deref()
            .map(|a| match a {
                "center" => "center",
                "right" => "right",
                _ => "left",
            })
            .map(str::to_string)
            .or_else(|| old_align.as_deref().and_then(|a| attr_of(a, "horizontal")));
        let vertical = spec
            .valign
            .as_deref()
            .map(|a| match a {
                "top" => "top",
                "middle" => "center",
                _ => "bottom",
            })
            .map(str::to_string)
            .or_else(|| old_align.as_deref().and_then(|a| attr_of(a, "vertical")));
        let wrap = spec.wrap.or_else(|| {
            old_align
                .as_deref()
                .and_then(|a| attr_of(a, "wrapText"))
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        });

        let mut align_attrs = String::new();
        if let Some(h) = &horizontal {
            align_attrs.push_str(&format!(" horizontal=\"{}\"", h));
        }
        if let Some(v) = &vertical {
            align_attrs.push_str(&format!(" vertical=\"{}\"", v));
        }
        if wrap == Some(true) {
            align_attrs.push_str(" wrapText=\"1\"");
        }

        let mut built = format!(
            "<xf numFmtId=\"{}\" fontId=\"{}\" fillId=\"{}\" borderId=\"{}\" xfId=\"0\"",
            new_numfmt_id, new_font_id, new_fill_id, new_border_id
        );
        if new_numfmt_id != 0 { built.push_str(" applyNumberFormat=\"1\""); }
        if new_font_id != 0 { built.push_str(" applyFont=\"1\""); }
        if new_fill_id != 0 { built.push_str(" applyFill=\"1\""); }
        if new_border_id != 0 { built.push_str(" applyBorder=\"1\""); }
        if align_attrs.is_empty() {
            built.push_str("/>");
        } else {
            built.push_str(&format!(" applyAlignment=\"1\"><alignment{}/></xf>", align_attrs));
        }

        Ok(Self::push_unique(&mut self.xfs, built))
    }

    /// Splice the changed pools back into the original XML.
    ///
    /// Everything not named here — dxfs, cellStyles, tableStyles, colors, the
    /// extension list — is still whatever it was, because it was never read.
    pub fn into_xml(self) -> String {
        let mut xml = self.xml;
        let numfmt_block = if self.numfmts.is_empty() {
            String::new()
        } else {
            let mut by_id: Vec<(&u32, &String)> = self.numfmts.iter().map(|(k, v)| (v, k)).collect();
            by_id.sort();
            let body: String = by_id
                .iter()
                .map(|(id, code)| {
                    format!("<numFmt numFmtId=\"{}\" formatCode=\"{}\"/>", id, escape(code))
                })
                .collect();
            format!("<numFmts count=\"{}\">{}</numFmts>", by_id.len(), body)
        };

        for (name, child, items) in [
            ("fonts", "font", &self.fonts),
            ("fills", "fill", &self.fills),
            ("borders", "border", &self.borders),
            ("cellXfs", "xf", &self.xfs),
        ] {
            let _ = child;
            let replacement = format!(
                "<{name} count=\"{}\">{}</{name}>",
                items.len(),
                items.concat(),
                name = name
            );
            if let Some((s, e, _)) = find_block(&xml, name) {
                xml.replace_range(s..e, &replacement);
            }
        }

        if !numfmt_block.is_empty() {
            match find_block(&xml, "numFmts") {
                Some((s, e, _)) => xml.replace_range(s..e, &numfmt_block),
                // numFmts must come first inside <styleSheet>.
                None => {
                    if let Some((s, _, _)) = find_block(&xml, "fonts") {
                        xml.insert_str(s, &numfmt_block);
                    }
                }
            }
        }
        xml
    }
}

/// Derive a font from an existing one, keeping every child element this code
/// does not manage.
///
/// A `<font>` can carry an underline, a scheme, a charset, a strike. Rebuilding
/// it from only the attributes the tool exposes would drop those silently — the
/// same shape of failure this whole area exists to stop.
fn derive_font(old: &str, spec: &StyleSpec) -> String {
    let inner = inner_of(old, "font").unwrap_or_default();
    let mut kept: Vec<String> = Vec::new();
    let mut bold = inner.contains("<b/>") || inner.contains("<b ");
    let mut italic = inner.contains("<i/>") || inner.contains("<i ");
    let mut size: Option<String> = None;
    let mut name: Option<String> = None;
    let mut color: Option<String> = None;

    for child in split_any_children(&inner) {
        let tag = child
            .trim_start_matches('<')
            .split(|c: char| c == ' ' || c == '/' || c == '>')
            .next()
            .unwrap_or("")
            .to_string();
        match tag.as_str() {
            "b" | "i" => {}
            "sz" => size = attr_of(&child, "val"),
            "name" | "rFont" => name = attr_of(&child, "val"),
            "color" => color = Some(child.clone()),
            _ => kept.push(child),
        }
    }

    if let Some(v) = spec.bold { bold = v; }
    if let Some(v) = spec.italic { italic = v; }
    if let Some(v) = spec.size { size = Some(format!("{}", v)); }
    if let Some(v) = &spec.font { name = Some(v.clone()); }
    if let Some(rgb) = spec.color.as_deref().and_then(argb) {
        color = Some(format!("<color rgb=\"{}\"/>", rgb));
    }

    let mut out = String::from("<font>");
    if bold { out.push_str("<b/>"); }
    if italic { out.push_str("<i/>"); }
    if let Some(s) = size { out.push_str(&format!("<sz val=\"{}\"/>", s)); }
    if let Some(c) = color { out.push_str(&c); }
    if let Some(n) = name { out.push_str(&format!("<name val=\"{}\"/>", escape(&n))); }
    for k in kept { out.push_str(&k); }
    out.push_str("</font>");
    out
}

/// Every direct child element of a fragment, as raw XML.
fn split_any_children(inner: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = inner.as_bytes();
    let mut i = 0;
    while i < inner.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let tag_end = match inner[i..].find('>') {
            Some(e) => i + e,
            None => break,
        };
        let tag = &inner[i..=tag_end];
        if tag.ends_with("/>") {
            out.push(tag.to_string());
            i = tag_end + 1;
            continue;
        }
        let name: String = tag
            .trim_start_matches('<')
            .split(|c: char| c == ' ' || c == '>')
            .next()
            .unwrap_or("")
            .to_string();
        let close = format!("</{}>", name);
        match inner[i..].find(&close) {
            Some(e) => {
                out.push(inner[i..i + e + close.len()].to_string());
                i += e + close.len();
            }
            None => {
                out.push(tag.to_string());
                i = tag_end + 1;
            }
        }
    }
    out
}

fn attr_of(tag: &str, key: &str) -> Option<String> {
    let needle = format!("{}=\"", key);
    let mut from = 0;
    while let Some(rel) = tag[from..].find(&needle) {
        let at = from + rel;
        // Must be preceded by whitespace, or it is the tail of another name
        // (fontId matching in applyFont, say).
        let ok = at == 0 || tag.as_bytes()[at - 1].is_ascii_whitespace();
        if ok {
            let start = at + needle.len();
            let end = tag[start..].find('"')? + start;
            return Some(unescape(&tag[start..end]));
        }
        from = at + needle.len();
    }
    None
}

fn inner_of(tag: &str, name: &str) -> Option<String> {
    find_block(tag, name).map(|(_, _, inner)| inner.to_string())
}

/// The whole element, opening tag included — which is where the attributes are.
///
/// `inner_of` returns an empty string for `<alignment …/>`, since a
/// self-closing element has no inside. Reading the alignment through it lost
/// every alignment on a restyle: centred, wrapped headers came back flush left
/// and one line tall, with nothing reporting it.
fn element_of(tag: &str, name: &str) -> Option<String> {
    find_block(tag, name).map(|(s, e, _)| tag[s..e].to_string())
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHEET: &str = r#"<?xml version="1.0"?><styleSheet xmlns="x"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf></cellXfs><dxfs count="1"><dxf><font><b/></font></dxf></dxfs><tableStyles count="0"/></styleSheet>"#;

    fn spec_bg(c: &str) -> StyleSpec {
        StyleSpec { bg: Some(c.into()), ..Default::default() }
    }

    #[test]
    fn parses_the_pools() {
        let s = Stylesheet::parse(SHEET).unwrap();
        assert_eq!(s.fonts.len(), 2);
        assert_eq!(s.fills.len(), 2);
        assert_eq!(s.borders.len(), 2);
        assert_eq!(s.xfs.len(), 2);
    }

    /// The rule the whole module exists for: a restyle must never touch an
    /// existing entry, because every cell sharing that index would change too.
    #[test]
    fn existing_entries_are_never_modified() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let before_fonts = s.fonts.clone();
        let before_fills = s.fills.clone();
        let before_xfs = s.xfs.clone();

        let idx = s.derive(Some(1), &spec_bg("#FFFF00")).unwrap();
        assert!(idx >= 2, "a new xf should have been appended, got {}", idx);
        assert_eq!(&s.fonts, &before_fonts, "a font entry changed");
        assert_eq!(s.fills[..2], before_fills[..], "a fill entry changed");
        assert_eq!(s.xfs[..2], before_xfs[..], "an xf entry changed");
    }

    #[test]
    fn a_derived_style_keeps_what_it_was_not_asked_to_change() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let idx = s.derive(Some(1), &spec_bg("#FFFF00")).unwrap();
        let xf = &s.xfs[idx as usize];
        // Same font and border as xf 1; only the fill is new.
        assert!(xf.contains("fontId=\"1\""), "{}", xf);
        assert!(xf.contains("borderId=\"1\""), "{}", xf);
        assert!(!xf.contains("fillId=\"1\""), "the fill should be a new one: {}", xf);
        // And the alignment it had is still there.
        assert!(xf.contains("horizontal=\"center\"") && xf.contains("wrapText=\"1\""), "{}", xf);
    }

    /// A solid fill paints fgColor; bgColor is ignored when the pattern is
    /// solid. Writing the colour to the wrong one is invisible and reports
    /// success.
    #[test]
    fn a_background_becomes_the_foreground_of_a_solid_fill() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let idx = s.derive(Some(0), &spec_bg("FFFF00")).unwrap();
        let fill_id: usize = attr_of(&s.xfs[idx as usize], "fillId").unwrap().parse().unwrap();
        assert!(s.fills[fill_id].contains("<fgColor rgb=\"FFFFFF00\"/>"), "{}", s.fills[fill_id]);
    }

    /// A font can carry things the tool has no word for. Rebuilding it from the
    /// attributes we know would drop them without a sound.
    #[test]
    fn deriving_a_font_keeps_children_we_do_not_model() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let spec = StyleSpec { bold: Some(false), ..Default::default() };
        let idx = s.derive(Some(1), &spec).unwrap();
        let font_id: usize = attr_of(&s.xfs[idx as usize], "fontId").unwrap().parse().unwrap();
        let f = &s.fonts[font_id];
        assert!(f.contains("scheme"), "the scheme was dropped: {}", f);
        assert!(f.contains("FFFFFFFF"), "the colour was dropped: {}", f);
        assert!(!f.contains("<b/>"), "bold:false did not take: {}", f);
    }

    #[test]
    fn identical_requests_reuse_the_same_index() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let a = s.derive(Some(1), &spec_bg("#FFFF00")).unwrap();
        let b = s.derive(Some(1), &spec_bg("#FFFF00")).unwrap();
        assert_eq!(a, b, "the pool grew for no reason");
    }

    #[test]
    fn a_custom_number_format_is_registered_once() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let spec = StyleSpec { numfmt: Some("#,##0\"円\"".into()), ..Default::default() };
        let a = s.derive(Some(0), &spec).unwrap();
        let b = s.derive(Some(0), &spec).unwrap();
        assert_eq!(a, b);
        let out = s.into_xml();
        assert!(out.contains("numFmtId=\"164\""), "{}", out);
        assert_eq!(out.matches("<numFmt ").count(), 1);
        // numFmts has to come before fonts in the schema.
        assert!(out.find("<numFmts").unwrap() < out.find("<fonts").unwrap());
    }

    /// Everything the module does not parse has to come out the other side.
    #[test]
    fn unrelated_blocks_survive() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        s.derive(Some(1), &spec_bg("#FFFF00")).unwrap();
        let out = s.into_xml();
        assert!(out.contains("<dxfs count=\"1\"><dxf><font><b/></font></dxf></dxfs>"), "{}", out);
        assert!(out.contains("<tableStyles count=\"0\"/>"), "{}", out);
        assert!(out.contains("xmlns=\"x\""));
    }

    #[test]
    fn counts_are_updated() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        s.derive(Some(1), &spec_bg("#FFFF00")).unwrap();
        let out = s.into_xml();
        assert!(out.contains("<fills count=\"3\">"), "{}", out);
        assert!(out.contains("<cellXfs count=\"3\">"), "{}", out);
        assert!(out.contains("<fonts count=\"2\">"), "fonts should not have grown: {}", out);
    }

    #[test]
    fn a_cell_with_no_style_starts_from_the_default() {
        let mut s = Stylesheet::parse(SHEET).unwrap();
        let idx = s.derive(None, &StyleSpec { bold: Some(true), ..Default::default() }).unwrap();
        let xf = &s.xfs[idx as usize];
        assert!(xf.contains("fillId=\"0\"") && xf.contains("borderId=\"0\""), "{}", xf);
    }

    #[test]
    fn colours_are_accepted_in_both_spellings() {
        assert_eq!(argb("#4472C4").as_deref(), Some("FF4472C4"));
        assert_eq!(argb("4472c4").as_deref(), Some("FF4472C4"));
        assert_eq!(argb("FF4472C4").as_deref(), Some("FF4472C4"));
        assert_eq!(argb("nope"), None);
    }

    #[test]
    fn an_empty_spec_is_recognised() {
        assert!(StyleSpec::default().is_empty());
        assert!(!spec_bg("#FFF000").is_empty());
    }
}
