// xlsx_style — what a generated workbook should look like before anyone asks.
//
// write_xlsx could already do all of this. The problem was that it only did it
// when told: no column widths unless `col_widths` was passed, no number formats
// unless a style named one, no filter, no frozen header, no print setup. A
// model that is thinking about the CONTENT does not think about any of that, so
// what came out was 8.43-character columns with Japanese text cut off, amounts
// reading 1800 instead of 1,800, and everything flush left.
//
// So the defaults move here: the shape of a workbook is decided from the data,
// and an explicit style still wins over all of it.
//
// Everything in this file is pure — no Workbook, no filesystem — because the
// decisions are the part worth testing and they are all decisions about text.

use serde_json::Value;

// ── Widths ──────────────────────────────────────────────────────────────────

/// Display width of one character, in "character units" — Excel's own measure,
/// where 1 is the width of a digit in the default font.
///
/// A kanji is two of those, which is the whole reason this is not `.len()` or
/// `.chars().count()`. rust_xlsxwriter's own `autofit()` counts characters, so
/// a column of Japanese comes out half as wide as it needs to be.
fn char_width(c: char) -> f64 {
    let cp = c as u32;
    let wide = matches!(cp,
        0x1100..=0x115F |            // Hangul Jamo
        0x2E80..=0x303E |            // CJK radicals, kana punctuation
        0x3041..=0x33FF |            // hiragana, katakana, CJK compatibility
        0x3400..=0x4DBF |            // CJK ext A
        0x4E00..=0x9FFF |            // CJK unified
        0xA000..=0xA4CF |
        0xAC00..=0xD7A3 |            // Hangul syllables
        0xF900..=0xFAFF |            // CJK compatibility ideographs
        0xFE30..=0xFE6F |
        0xFF00..=0xFF60 |            // fullwidth forms
        0xFFE0..=0xFFE6 |
        0x20000..=0x3FFFD            // CJK ext B and beyond
    );
    if wide { 2.0 } else { 1.0 }
}

/// Display width of a string, counting CJK as two columns.
pub fn display_width(s: &str) -> f64 {
    s.chars().map(char_width).sum()
}

// ── What a column holds ─────────────────────────────────────────────────────

/// The shape of a column's data, which decides its number format and alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    /// Whole numbers big enough to want thousands separators.
    Count,
    /// Whole numbers that are small — years, quantities, IDs. Grouping them
    /// would turn 2026 into 2,026.
    SmallInt,
    Decimal,
    Percent,
    Date,
    /// Long enough that it needs wrapping rather than a very wide column.
    LongText,
    Text,
}

impl ColumnKind {
    /// The Excel number format code, or None to leave it General.
    pub fn num_format(self) -> Option<&'static str> {
        match self {
            ColumnKind::Count => Some("#,##0"),
            ColumnKind::Decimal => Some("#,##0.00"),
            ColumnKind::Percent => Some("0.0%"),
            ColumnKind::Date => Some("yyyy/mm/dd"),
            ColumnKind::SmallInt | ColumnKind::LongText | ColumnKind::Text => None,
        }
    }

    /// Numbers right, text left. This one change does more for legibility than
    /// any amount of colour.
    pub fn align_right(self) -> bool {
        matches!(self, ColumnKind::Count | ColumnKind::SmallInt | ColumnKind::Decimal | ColumnKind::Percent)
    }

    pub fn wrap(self) -> bool {
        matches!(self, ColumnKind::LongText)
    }
}

fn as_number(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Does this string read as a date? Deliberately narrow: only the unambiguous
/// ISO-ish forms, because guessing at 03/04/2026 gets the month wrong half the
/// time and a wrong date is worse than an unformatted one.
fn looks_like_date(s: &str) -> bool {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 8 || b.len() > 10 {
        return false;
    }
    let sep = if s.contains('-') { '-' } else if s.contains('/') { '/' } else { return false };
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() != 3 {
        return false;
    }
    let y = parts[0].parse::<u32>().ok();
    let m = parts[1].parse::<u32>().ok();
    let d = parts[2].parse::<u32>().ok();
    match (y, m, d) {
        (Some(y), Some(m), Some(d)) => {
            parts[0].len() == 4 && (1900..=2999).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)
        }
        _ => false,
    }
}

/// Decide a column's kind from its values and its header.
///
/// Blank cells are ignored rather than counted as text: a mostly-filled amount
/// column is still an amount column.
pub fn infer_column(header: Option<&str>, values: &[&Value]) -> ColumnKind {
    let filled: Vec<&&Value> = values
        .iter()
        .filter(|v| !matches!(v, Value::Null) && v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(true))
        .collect();
    if filled.is_empty() {
        return ColumnKind::Text;
    }

    let numbers: Vec<f64> = filled.iter().filter_map(|v| as_number(v)).collect();
    if numbers.len() == filled.len() {
        let all_int = numbers.iter().all(|n| n.fract() == 0.0);
        // A header that says so, and values that fit, mean a rate — nothing else
        // is a reliable signal, and formatting 0.5 as 50% when it was a
        // measurement would be a lie.
        let pct_header = header
            .map(|h| h.contains('率') || h.contains('%') || h.to_lowercase().contains("rate"))
            .unwrap_or(false);
        if pct_header && numbers.iter().all(|n| (0.0..=1.0).contains(n)) {
            return ColumnKind::Percent;
        }
        if all_int {
            // Grouping helps from 1000 up — but not everything four digits long
            // is a quantity. A column of years becomes 2,026 and a part number
            // becomes 1,234, and both read as wrong rather than as formatted.
            // Two things say "this is a label that happens to be a number": the
            // header, and values that all sit in the range years live in.
            let label_header = header
                .map(|h| {
                    let l = h.to_lowercase();
                    h.contains('年') || h.contains("番号") || h.contains("コード")
                        || l.contains("year") || l.contains("id") || l.contains("no.")
                        || l == "no" || l.contains("code")
                })
                .unwrap_or(false);
            let all_years = numbers.iter().all(|n| (1900.0..=2100.0).contains(n));
            if label_header || all_years {
                return ColumnKind::SmallInt;
            }
            return if numbers.iter().any(|n| n.abs() >= 1000.0) {
                ColumnKind::Count
            } else {
                ColumnKind::SmallInt
            };
        }
        return ColumnKind::Decimal;
    }

    let strings: Vec<&str> = filled.iter().filter_map(|v| v.as_str()).collect();
    if strings.len() == filled.len() && !strings.is_empty() && strings.iter().all(|s| looks_like_date(s)) {
        return ColumnKind::Date;
    }

    let avg = if strings.is_empty() {
        0.0
    } else {
        strings.iter().map(|s| display_width(s)).sum::<f64>() / strings.len() as f64
    };
    if avg > 30.0 {
        ColumnKind::LongText
    } else {
        ColumnKind::Text
    }
}

// ── Column width ────────────────────────────────────────────────────────────

/// How wide the cell's text will actually be once the number format has been
/// applied.
///
/// Measuring the raw value is not enough: `#,##0"円"` turns 1800 into `1,800円`,
/// which is three columns wider than the digits alone.
pub fn rendered_width(v: &Value, kind: ColumnKind, num_format: Option<&str>) -> f64 {
    let fmt = num_format.or_else(|| kind.num_format());
    match v {
        Value::Null => 0.0,
        Value::Number(_) => {
            let n = v.as_f64().unwrap_or(0.0);
            let mut body = match kind {
                ColumnKind::Percent => format!("{:.1}%", n * 100.0),
                ColumnKind::Decimal => format!("{:.2}", n.abs()),
                _ => format!("{}", n.abs().trunc()),
            };
            // Thousands separators, if the format asks for them.
            if fmt.map(|f| f.contains("#,##")).unwrap_or(false) && !matches!(kind, ColumnKind::Percent) {
                let (int_part, rest) = match body.split_once('.') {
                    Some((a, b)) => (a.to_string(), format!(".{}", b)),
                    None => (body.clone(), String::new()),
                };
                let grouped: String = int_part
                    .as_bytes()
                    .rchunks(3)
                    .rev()
                    .map(|c| std::str::from_utf8(c).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(",");
                body = format!("{}{}", grouped, rest);
            }
            if n < 0.0 {
                body.insert(0, '-');
            }
            // Literal text baked into the format, e.g. the 円 in #,##0"円".
            let literal: f64 = fmt
                .map(|f| {
                    f.split('"')
                        .skip(1)
                        .step_by(2)
                        .map(display_width)
                        .sum()
                })
                .unwrap_or(0.0);
            display_width(&body) + literal
        }
        Value::Bool(_) => 5.0,
        Value::String(s) => {
            if kind == ColumnKind::Date {
                display_width("2026/09/30")
            } else {
                display_width(s)
            }
        }
        other => display_width(&other.to_string()),
    }
}

/// Column width in Excel character units.
///
/// Bounded at both ends: a column narrower than the header is unreadable, and
/// one wider than the screen makes the sheet unusable. A wrapping column is
/// capped harder still, since that is what wrapping is for.
pub fn column_width(header: Option<&str>, widths: &[f64], kind: ColumnKind) -> f64 {
    let mut w = widths.iter().cloned().fold(0.0_f64, f64::max);
    if let Some(h) = header {
        // A wrapped header is allowed to be narrower than its text.
        let hw = display_width(h);
        w = w.max(if kind.wrap() { hw.min(20.0) } else { hw });
    }
    let cap = if kind.wrap() { 45.0 } else { 60.0 };
    (w + 1.6).clamp(6.0, cap)
}

// ── Presets ─────────────────────────────────────────────────────────────────

/// A house style for a generated sheet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Preset {
    pub name: &'static str,
    /// Header band. None = leave the header as plain bold.
    pub header_fill: Option<&'static str>,
    pub header_font_color: Option<&'static str>,
    pub header_height: Option<f64>,
    /// Border colour for the whole data range. None = no grid.
    pub grid: Option<&'static str>,
    /// Fill for every other data row. None = no banding.
    pub zebra: Option<&'static str>,
    pub freeze_header: bool,
    pub autofilter: bool,
    pub landscape: bool,
    pub fit_to_width: bool,
    /// Repeat the header row at the top of every printed page.
    pub repeat_header: bool,
    pub page_footer: bool,
    pub base_font: Option<&'static str>,
}

/// The default. Named for what it is: the shape a Japanese business sheet takes
/// when a person lays one out by hand.
pub const BUSINESS_JA: Preset = Preset {
    name: "business-ja",
    header_fill: Some("#4472C4"),
    header_font_color: Some("#FFFFFF"),
    header_height: Some(28.0),
    grid: Some("#D0D0D0"),
    zebra: None,
    freeze_header: true,
    autofilter: true,
    landscape: false,
    fit_to_width: true,
    repeat_header: true,
    page_footer: true,
    base_font: Some("Yu Gothic"),
};

/// For data somebody else's program will read: no colour, no filter, no
/// decoration that a parser has to look past.
pub const PLAIN: Preset = Preset {
    name: "plain",
    header_fill: None,
    header_font_color: None,
    header_height: None,
    grid: None,
    zebra: None,
    freeze_header: false,
    autofilter: false,
    landscape: false,
    fit_to_width: false,
    repeat_header: false,
    page_footer: false,
    base_font: None,
};

/// For something to be read on paper: banded rows, landscape.
pub const REPORT: Preset = Preset {
    name: "report",
    header_fill: Some("#2F5597"),
    header_font_color: Some("#FFFFFF"),
    header_height: Some(30.0),
    grid: Some("#BFBFBF"),
    zebra: Some("#F2F6FC"),
    freeze_header: true,
    autofilter: false,
    landscape: true,
    fit_to_width: true,
    repeat_header: true,
    page_footer: true,
    base_font: Some("Yu Gothic"),
};

/// Look up a preset by name. An unknown name falls back to the default rather
/// than failing the write — a misspelt preset should not cost the user the
/// spreadsheet.
pub fn preset(name: Option<&str>) -> Preset {
    match name.map(str::trim).map(str::to_lowercase).as_deref() {
        Some("plain") | Some("none") => PLAIN,
        Some("report") => REPORT,
        _ => BUSINESS_JA,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cjk_counts_double() {
        assert_eq!(display_width("abc"), 3.0);
        assert_eq!(display_width("品目"), 4.0);
        assert_eq!(display_width("ねじM4"), 6.0);
        assert_eq!(display_width("１２３"), 6.0); // fullwidth digits
        assert_eq!(display_width(""), 0.0);
    }

    fn vals(v: Vec<Value>) -> Vec<Value> { v }

    fn kind_of(header: Option<&str>, v: &[Value]) -> ColumnKind {
        let refs: Vec<&Value> = v.iter().collect();
        infer_column(header, &refs)
    }

    #[test]
    fn big_whole_numbers_get_thousands_separators() {
        let k = kind_of(Some("金額"), &vals(vec![json!(1800), json!(25), json!(3200)]));
        assert_eq!(k, ColumnKind::Count);
        assert_eq!(k.num_format(), Some("#,##0"));
        assert!(k.align_right());
    }

    /// 2026 must not become 2,026, and an id of 7 must not become 7 with a
    /// comma waiting for it.
    #[test]
    fn small_whole_numbers_are_left_alone() {
        let k = kind_of(Some("年"), &vals(vec![json!(2024), json!(2025), json!(2026)]));
        assert_eq!(k, ColumnKind::SmallInt);
        assert_eq!(k.num_format(), None);
        assert!(k.align_right(), "a number still belongs on the right");
    }

    /// A part number is not a quantity, however many digits it has.
    #[test]
    fn labels_that_happen_to_be_numbers_are_not_grouped() {
        assert_eq!(kind_of(Some("管理番号"), &vals(vec![json!(10045), json!(10046)])), ColumnKind::SmallInt);
        assert_eq!(kind_of(Some("ID"), &vals(vec![json!(90210)])), ColumnKind::SmallInt);
        // No header to go on, but every value sits in the years.
        assert_eq!(kind_of(None, &vals(vec![json!(2024), json!(2026)])), ColumnKind::SmallInt);
        // A real quantity in the same range still groups.
        assert_eq!(kind_of(Some("金額"), &vals(vec![json!(1800), json!(25000)])), ColumnKind::Count);
    }

    #[test]
    fn decimals_get_two_places() {
        assert_eq!(kind_of(None, &vals(vec![json!(1.5), json!(2.25)])), ColumnKind::Decimal);
    }

    /// Only when the header says so. 0.5 in a column called "厚み" is 0.5.
    #[test]
    fn percentages_need_the_header_to_say_so() {
        assert_eq!(kind_of(Some("達成率"), &vals(vec![json!(0.8), json!(1.0)])), ColumnKind::Percent);
        assert_eq!(kind_of(Some("厚み"), &vals(vec![json!(0.8), json!(1.0)])), ColumnKind::Decimal);
        // Out of range, so not a rate however it is labelled: these are already
        // percentage POINTS, and 0.0% would render 80 as 8000%.
        assert_eq!(kind_of(Some("達成率"), &vals(vec![json!(80.0), json!(100.0)])), ColumnKind::SmallInt);
    }

    #[test]
    fn only_unambiguous_dates_are_dates() {
        assert_eq!(kind_of(None, &vals(vec![json!("2026-09-30"), json!("2026/10/01")])), ColumnKind::Date);
        // 03/04/2026 is March or April depending on where you live. Guessing
        // wrong writes a wrong date, which is worse than no format at all.
        assert_ne!(kind_of(None, &vals(vec![json!("03/04/2026")])), ColumnKind::Date);
        assert_ne!(kind_of(None, &vals(vec![json!("2026-13-01")])), ColumnKind::Date);
    }

    #[test]
    fn long_prose_wraps() {
        let long = "ここに長い説明が入ります。折り返さないと列が画面をはみ出します。";
        assert_eq!(kind_of(None, &vals(vec![json!(long)])), ColumnKind::LongText);
        assert!(kind_of(None, &vals(vec![json!(long)])).wrap());
    }

    #[test]
    fn blanks_do_not_turn_a_number_column_into_text() {
        assert_eq!(
            kind_of(Some("数量"), &vals(vec![json!(10), json!(null), json!(""), json!(4)])),
            ColumnKind::SmallInt
        );
    }

    #[test]
    fn an_empty_column_is_text() {
        assert_eq!(kind_of(None, &[]), ColumnKind::Text);
        assert_eq!(kind_of(None, &vals(vec![json!(null)])), ColumnKind::Text);
    }

    /// The width has to account for what the number format ADDS, or the column
    /// is sized for "1800" and shows "1,800円" as ###.
    #[test]
    fn width_counts_separators_and_literal_suffixes() {
        let plain = rendered_width(&json!(1800), ColumnKind::Count, None);
        assert_eq!(plain, display_width("1,800"));
        let with_yen = rendered_width(&json!(1800), ColumnKind::Count, Some("#,##0\"円\""));
        assert_eq!(with_yen, display_width("1,800") + 2.0);
        assert!(with_yen > plain);
    }

    #[test]
    fn width_handles_negatives_and_decimals() {
        assert_eq!(rendered_width(&json!(-1234), ColumnKind::Count, None), display_width("-1,234"));
        assert_eq!(rendered_width(&json!(1.5), ColumnKind::Decimal, None), display_width("1.50"));
        assert_eq!(rendered_width(&json!(0.825), ColumnKind::Percent, None), display_width("82.5%"));
    }

    #[test]
    fn a_column_is_never_narrower_than_its_header() {
        let w = column_width(Some("品目名称"), &[display_width("ねじ")], ColumnKind::Text);
        assert!(w >= display_width("品目名称"), "{}", w);
    }

    #[test]
    fn widths_stay_inside_the_screen() {
        let huge = display_width(&"あ".repeat(200));
        assert_eq!(column_width(None, &[huge], ColumnKind::Text), 60.0);
        assert_eq!(column_width(None, &[huge], ColumnKind::LongText), 45.0);
        assert_eq!(column_width(None, &[1.0], ColumnKind::Text), 6.0);
    }

    #[test]
    fn presets_resolve_and_default() {
        assert_eq!(preset(Some("plain")).name, "plain");
        assert_eq!(preset(Some("REPORT")).name, "report");
        assert_eq!(preset(None).name, "business-ja");
        // A typo must not cost the user the file.
        assert_eq!(preset(Some("bussiness")).name, "business-ja");
    }

    #[test]
    fn plain_really_is_plain() {
        let p = preset(Some("plain"));
        assert!(p.header_fill.is_none() && p.grid.is_none() && !p.autofilter && !p.freeze_header);
    }
}
