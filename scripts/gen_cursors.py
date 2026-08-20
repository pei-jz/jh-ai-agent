# -*- coding: utf-8 -*-
"""Generate src/styles/cursors.css — the bamboo-slip theme's mouse cursors.

    python scripts/gen_cursors.py

The stylesheet is machine-generated: each cursor is an inline SVG data URI, and
hand-editing percent-encoded path data is not something anyone should be asked to
do. Change the drawings HERE and regenerate. src/styles/__tests__/cursors.test.js
pins the invariants that the generated file has to keep.

Design notes, so the choices are not re-litigated from scratch:

  * The theme's ground is charred bamboo (#3a2e1e), so every glyph is filled PALE
    and outlined dark - the same reason the stock Windows arrow is white with a
    black edge. An early revision filled the brush tuft with ink and the POINTING
    END of the pointer became its least visible part. Ink character comes from
    hairlines drawn INSIDE a pale shape, never from darkening a tip.

  * The OS pointing hand is roughly 6px of finger over 16px of fist - a ratio
    near 0.37. A first attempt at the link cursor was 3.4 over 21.6, or 0.16, and
    the "finger" stopped reading entirely. The adopted pointer measures 6.6 over
    18.2 = 0.36. If you reshape it, keep that ratio.

  * Hotspots sit on the pointing tip, inset from the edge. Chromium DISCARDS a
    cursor whose hotspot falls outside its image and silently uses the system
    default, so nothing sits at 0,0.

  * Every rule ends in a keyword fallback. A data URI that fails to parse is not
    an error anywhere - the cursor just quietly reverts - so the fallback is what
    stops a typo from reading as "the theme has no cursors".

  * Cursor bitmaps do NOT scale with the display, and Windows discards anything
    above 32x32, so 28px is the working ceiling. On a HiDPI screen these look
    slightly soft; that is a limit of CSS cursors, not of the drawing.
"""
import io
import os
from urllib.parse import quote

INK       = '#1a1208'   # near-black - outlines only, never a fill on a light ground
PAPER     = '#f2ead6'   # the bright fill; this is what makes a glyph findable
BAMBOO    = '#d9c9a3'   # pale split bamboo
BAMBOO_D  = '#a8905f'   # shaded bamboo - hairlines, slat divisions
CORD      = '#8a6f45'   # binding cord / ferrule
VERDIGRIS = '#7fc4b8'   # bronze patina - reserved for "this is interactive"

OUT = 'stroke="%s" stroke-width="1.2" stroke-linejoin="round"' % INK


def svg(w, h, body):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
            'viewBox="0 0 %d %d">%s</svg>' % (w, h, w, h, body))


def uri(s):
    # `#` MUST be encoded or it starts a fragment and truncates the colour.
    # `<`/`>` are tolerated by Chromium but not by every engine, so encode those.
    return 'url("data:image/svg+xml,%s")' % quote(s, safe="/:=?[]@!$'()*+,;")


def brush_arrow():
    """default - 筆. A brush laid along the arrow diagonal.

    Pointed tip at (2,2), belly about 8px across at (8.5,8.5), ferrule, then a
    handle tapering to almost nothing at (25.5,25.5): an arrow at a glance, a
    brush on a second look.
    """
    body = (
        # handle, drawn first so the ferrule laps over its top
        '<path d="M10.4 12.6 L25.22 25.78 L25.78 25.22 L12.6 10.4 Z" '
        'fill="%s" %s/>' % (BAMBOO, OUT)
        # tuft: convex on both flanks, so the swell reads as hair under load
        + '<path d="M2 2 C3.2 5.4 4.4 9.4 5.7 11.4 C7.2 13.2 8.6 13.4 10.1 12.9 '
          'L12.9 10.1 C13.4 8.6 13.2 7.2 11.4 5.7 C9.4 4.4 5.4 3.2 2 2 Z" '
          'fill="%s" %s/>' % (PAPER, OUT)
        # hairs fanning from the tip - the brush reading, at no cost to contrast
        + '<path d="M3.2 3.2 C4.5 6.3 5.5 9.2 6.5 11.4" fill="none" stroke="%s" '
          'stroke-width="0.8" opacity="0.75" stroke-linecap="round"/>' % BAMBOO_D
        + '<path d="M3.2 3.2 C6.3 4.5 9.2 5.5 11.4 6.5" fill="none" stroke="%s" '
          'stroke-width="0.8" opacity="0.75" stroke-linecap="round"/>' % BAMBOO_D
        + '<path d="M2.9 2.9 L8.6 8.6" fill="none" stroke="%s" stroke-width="0.75" '
          'opacity="0.6" stroke-linecap="round"/>' % BAMBOO_D
        # ferrule
        + '<path d="M10.5 13.0 L13.0 10.5" stroke="%s" stroke-width="3.0" '
          'stroke-linecap="round"/>' % CORD
        + '<path d="M10.5 13.0 L13.0 10.5" stroke="%s" stroke-width="3.0" '
          'stroke-linecap="round" opacity="0.22"/>' % INK
    )
    return svg(28, 28, body)


def slip_bundle():
    """pointer - 簡策. One slip standing proud of a rolled bundle.

    Chosen over a brush-on-a-plinth and a bronze seal. A rolled bundle of slips
    is already a wide rounded mass and a single slip pulled out of it is already
    a narrow upright, so this lands on the pointing hand's silhouette without
    being forced into it - and it is the most bamboo-slip of the candidates.

    Measured finger:fist = 6.6 : 18.2 = 0.36, against the OS hand's ~0.37.
    """
    body = (
        # the bundle, seen end-on
        '<rect x="2.4" y="13.4" width="18.2" height="11.6" rx="2.4" '
        'fill="%s" %s/>' % (BAMBOO, OUT)
        # individual slips within it
        + '<path d="M6.0 14.2 L6.0 24.2 M9.4 14.2 L9.4 24.2 M12.8 14.2 L12.8 24.2 '
          'M16.2 14.2 L16.2 24.2" stroke="%s" stroke-width="0.85" opacity="0.75" '
          'stroke-linecap="round"/>' % BAMBOO_D
        # the binding cord - the one verdigris element, and only on the pointer
        + '<path d="M3.5 19.2 L19.5 19.2" stroke="%s" stroke-width="1.8" '
          'stroke-linecap="round"/>' % VERDIGRIS
        # the slip standing proud - pale, so the pointing end is the bright end.
        # 7.0 across: at 5.4 it read as a splinter rather than a slip.
        + '<rect x="5.5" y="2.0" width="7.0" height="12.6" rx="2.4" '
          'fill="%s" %s/>' % (PAPER, OUT)
        + '<path d="M5.7 6.4 L12.3 6.4 M5.7 10.4 L12.3 10.4" stroke="%s" '
          'stroke-width="1.3"/>' % CORD
        + '<path d="M9.0 3.4 L9.0 13.4" stroke="%s" stroke-width="0.7" '
          'opacity="0.65"/>' % BAMBOO_D
    )
    return svg(28, 28, body)


def slip_beam():
    """text - 竹簡. A bound slat standing upright.

    The one form that needed no translation: an I-beam already IS a vertical bar.
    """
    body = (
        '<rect x="3" y="2" width="6" height="26" rx="1.4" fill="%s" stroke="%s" '
        'stroke-width="1.2"/>' % (BAMBOO, INK)
        + '<path d="M3 9 L9 9 M3 21 L9 21" stroke="%s" stroke-width="1.6"/>' % CORD
        + '<path d="M6 3.5 L6 26.5" stroke="%s" stroke-width="0.7" '
          'opacity="0.7"/>' % BAMBOO_D
    )
    return svg(12, 30, body)


POINTER_SEL = ('a, button, [role="button"], summary, select, label, .dt-tab, '
               '.mfilter-btn, .mstep-header, .mpanel-toggle, .mtask-row')
TEXT_SEL = ('input:not([type="checkbox"]):not([type="radio"]):not([type="range"])'
            ':not([type="color"]):not([type="submit"]):not([type="button"]), '
            'textarea, [contenteditable="true"]')

HEAD = '''/* cursors - the bamboo-slip theme's mouse cursors.
 *
 * GENERATED FILE - do not edit. Run `python scripts/gen_cursors.py` instead; the
 * drawings and the reasoning behind them live there. Invariants are pinned in
 * src/styles/__tests__/cursors.test.js.
 *
 * Applied when <html> carries BOTH data-theme="bamboo-ancient" and
 * data-cursor="bamboo". src/index.html sets the latter before first paint.
 *
 *   default  筆    a brush along the arrow diagonal: pointed tip, swelling
 *                  belly, tail tapering to nothing
 *   pointer  簡策  one slip standing proud of a rolled bundle of slips
 *   text     竹簡  a bound slat - an I-beam already IS a vertical bar
 *
 * Every glyph is filled PALE and outlined dark because the theme's ground is
 * charred bamboo; a dark cursor disappears into it. Every rule ends in a keyword
 * fallback because a data URI that fails to parse reverts silently rather than
 * erroring. Hotspots are inset from the edge because Chromium discards a cursor
 * whose hotspot falls outside its image.
 *
 * Only `cursor` is set here, and only under the bamboo theme. No other theme is
 * touched, and removing `data-cursor` restores the system cursors.
 */
'''

SEL = ':root[data-theme="bamboo-ancient"][data-cursor="bamboo"]'

out = [HEAD]

out.append('/* default */')
out.append('%s,\n%s * {' % (SEL, SEL))
out.append('  cursor: %s 2 2, default;' % uri(brush_arrow()))
out.append('}')
out.append('')

out.append('/* pointer */')
out.append(',\n'.join('%s %s' % (SEL, p.strip()) for p in POINTER_SEL.split(',')) + ' {')
out.append('  cursor: %s 9 2, pointer;' % uri(slip_bundle()))
out.append('}')
out.append('')

out.append('/* text */')
out.append(',\n'.join('%s %s' % (SEL, p.strip()) for p in TEXT_SEL.split(',')) + ' {')
out.append('  cursor: %s 6 15, text;' % uri(slip_beam()))
out.append('}')
out.append('')

DOC = '''<!doctype html>
<html lang="ja" data-theme="bamboo-ancient" data-cursor="bamboo">
<head>
<meta charset="utf-8">
<title>竹簡テーマ — マウスカーソル</title>
<!--
  GENERATED by scripts/gen_cursors.py, from the same run that writes
  src/styles/cursors.css. The glyphs below ARE the shipping glyphs, so the
  picture cannot drift away from the product. Regenerate; do not hand-edit.

  Self-contained: no server, no relative assets. Opening it any way works.
-->
<style>
/* Inlined deliberately: a <link> to ../../src/styles/*.css resolves from disk
   and silently does not from another origin, and a stylesheet that fails to load
   is not an error anywhere — the page would just quietly show no theme and no
   cursors. Snapshot copies, regenerated with the CSS. */
__TOKENS__

__CURSORS__

  /* dashboard.css sets `body { overflow: hidden }` — right for the app shell,
     where each pane scrolls itself, wrong for a document that scrolls as one. */
  html { overflow-y: auto; }
  body { margin: 0; padding: 28px 28px 56px; overflow: visible;
         background: var(--bg-primary);
         background-image: var(--grain), var(--slip);
         color: var(--text-primary); line-height: 1.65;
         font-family: var(--font-sans, system-ui), sans-serif; }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: .04em; }
  .h2 { font-size: 15px; margin: 30px 0 6px; letter-spacing: .04em; }
  .lede { color: var(--text-secondary); font-size: 12.5px; margin: 0 0 16px; max-width: 68ch; }
  code { font-family: var(--font-mono, monospace); font-size: 11.5px; color: var(--accent); }
  small { color: var(--text-tertiary); font-size: 10.5px; }
  b { color: var(--text-primary); }
  .row { display: flex; align-items: center; gap: 22px; margin-bottom: 11px;
         border: 1px solid var(--border); border-radius: 9px; padding: 14px 18px;
         background: var(--bg-card-solid); }
  .glyphs { display: flex; gap: 20px; align-items: flex-end; flex: none; }
  .cell { text-align: center; }
  .box { height: 122px; display: flex; align-items: center; justify-content: center; }
  .meta h3 { font-size: 14px; margin: 0 0 4px; }
  .meta .cn { color: var(--text-tertiary); font-weight: 400; font-size: 12px; }
  .meta p { font-size: 12.5px; margin: 0; color: var(--text-secondary); max-width: 54ch; }
  .meta .hs { margin-top: 6px; font-size: 11px; color: var(--text-tertiary); }
  .switch { display: flex; gap: 18px; align-items: center; padding: 11px 15px;
            border: 1px solid var(--border); border-radius: 8px;
            background: var(--bg-card-solid); font-size: 12.5px; margin-bottom: 14px; }
  .switch label { display: flex; gap: 6px; align-items: center; }
  .try { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .card { border: 1px solid var(--border); border-radius: 9px;
          background: var(--bg-card-solid); padding: 15px 17px 18px; }
  .card h4 { font-size: 12px; margin: 0 0 9px; letter-spacing: .05em;
             text-transform: uppercase; color: var(--text-tertiary); font-weight: 600; }
  .card p { font-size: 12.5px; margin: 0 0 9px; color: var(--text-secondary); }
  .card a { color: var(--accent); }
  .card button { font: inherit; font-size: 12.5px; padding: 6px 13px;
                 border: 1px solid var(--border); border-radius: 6px;
                 background: var(--bg-tertiary); color: var(--text-primary); }
  .card input, .card textarea { width: 100%; padding: 7px 9px;
    background: var(--bg-input); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12.5px; }
  .note { margin-top: 26px; padding: 14px 16px; font-size: 12px; line-height: 1.75;
          border: 1px solid var(--border-light); border-left: 3px solid var(--accent);
          border-radius: 6px; background: var(--bg-tertiary);
          color: var(--text-secondary); max-width: 78ch; }
</style>
</head>
<body>
  <h1>竹簡テーマ — マウスカーソル</h1>
  <p class="lede">
    採用・実装済み。<code>data-theme="bamboo-ancient"</code> かつ
    <code>data-cursor="bamboo"</code> のときだけ効き、他テーマには一切影響しません。
  </p>

  <h2 class="h2">確定した一式</h2>
__CARDS__

  <h2 class="h2">実際に動かす</h2>
  <div class="switch">
    <span>カーソル:</span>
    <label><input type="radio" name="cs" value="bamboo" checked> 竹簡一式</label>
    <label><input type="radio" name="cs" value=""> OS 既定（比較用）</label>
  </div>
  <div class="try">
    <div class="card"><h4>通常</h4>
      <p>この文章の上。先端の見つけやすさを確認してください。</p>
      <p style="background:var(--bg-primary);padding:9px;border-radius:6px">一段暗い面でも。</p></div>
    <div class="card"><h4>リンク・ボタン</h4>
      <p><a href="#">リンクの上に置く</a></p>
      <p><button type="button">ボタンでも同じ</button></p></div>
    <div class="card"><h4>入力</h4>
      <input placeholder="ここに入力">
      <p style="margin-top:9px"><textarea rows="2" placeholder="複数行でも"></textarea></p></div>
  </div>

  <h2 class="h2">検討中に判明した2点</h2>
  <div class="note">
    <b>1. 暗い地では、塗る色ではなく塗る場所を間違えると消える。</b>
    最初の筆は穂先を <code>#1a1208</code> で塗っており、地の焦げ竹
    (<code>#3a2e1e</code>) に沈んで「指し示す先端」が最も見えない部分になっていました。
    現在は全グリフを淡色で塗り、暗い輪郭を付けています — Windows 標準の矢印が
    白地に黒縁である理由と同じです。筆らしさは穂の<em>内側</em>の毛筋で出しています。
    <br><br>
    <b>2. リンクカーソルは「細さ」ではなく「比率」で読めなくなる。</b>
    OS の指カーソルは指:拳がおよそ <b>0.37</b>。試作は 3.4px : 21.6px = <b>0.16</b> で、
    台座が筆を飲み込んでいました。採用案は 6.6 : 18.2 = <b>0.36</b> です。
    <br><br>
    <b>制約:</b> カーソル画像はディスプレイの拡大率に追従しません。HiDPI では少し
    眠く見えます — CSS カーソルの限界であって、絵の粗さではありません。
  </div>

  <script>
    // Set the attribute on <html>: the shipping rules are :root-scoped, so
    // switching anywhere else would not exercise the real selectors.
    document.querySelectorAll('input[name=cs]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (r.value) document.documentElement.dataset.cursor = r.value;
        else delete document.documentElement.dataset.cursor;
      });
    });
  </script>
</body>
</html>
'''

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
dest = os.path.join(root, 'src', 'styles', 'cursors.css')
css = '\n'.join(out)
io.open(dest, 'w', encoding='utf-8').write(css)
print('wrote %s' % os.path.normpath(dest))


# ── the reference page ───────────────────────────────────────────────────
# Written from the same run, so the picture cannot drift away from the product.
# It inlines the theme tokens and the cursor rules rather than <link>ing them:
# relative links resolve when the file is opened from disk and silently do NOT
# when it is served or snapshotted from another origin, and a stylesheet that
# fails to load is not an error anywhere.
def build_doc(css_text):
    dash_path = os.path.join(root, 'src', 'styles', 'dashboard.css')
    dash = io.open(dash_path, encoding='utf-8').read()
    start = dash.index(':root[data-theme="bamboo-ancient"]')
    tokens = dash[start:dash.index('}', dash.index('{', start)) + 1]

    def big(glyph, hx, hy, factor=4):
        w = int(glyph.split('width="')[1].split('"')[0])
        h = int(glyph.split('height="')[1].split('"')[0])
        s = glyph.replace('width="%d" height="%d"' % (w, h),
                          'width="%d" height="%d"' % (w * factor, h * factor), 1)
        ring = ('<circle cx="%s" cy="%s" r="1.7" fill="none" stroke="#ff6b6b" '
                'stroke-width="0.7"/><circle cx="%s" cy="%s" r="0.5" '
                'fill="#ff6b6b"/>' % (hx, hy, hx, hy))
        return s.replace('</svg>', ring + '</svg>')

    rows = [
        (brush_arrow(), 2, 2, '通常', '筆',
         '45°軸上に、先端が尖り → 中央で腹がふくらみ → 口金 → 軸が先細り。'
         '一見矢印、二度見で筆。'),
        (slip_bundle(), 9, 2, 'リンク', '簡策',
         '巻いた簡の束から1枚が抜き出た形。束は最初から幅広の塊、'
         '抜けた1枚は最初から細い縦なので、無理なく指カーソルの輪郭に乗ります。'),
        (slip_beam(), 6, 15, '入力', '竹簡',
         '綴じ紐のある簡。I ビームは元々縦棒なので、'
         '3つの中で唯一「翻訳」が要りませんでした。'),
    ]
    cards = ''.join(
        '<div class="row">'
        '<div class="glyphs">'
        '<div class="cell"><div class="box">%s</div><small>4倍・赤丸=ホットスポット</small></div>'
        '<div class="cell"><div class="box">%s</div><small>実寸</small></div></div>'
        '<div class="meta"><h3>%s <span class="cn">%s</span></h3><p>%s</p>'
        '<p class="hs">hotspot <code>%d %d</code></p></div></div>'
        % (big(g, hx, hy), g, jp, cn, desc, hx, hy)
        for g, hx, hy, jp, cn, desc in rows)

    html = DOC.replace('__TOKENS__', tokens).replace('__CURSORS__', css_text) \
              .replace('__CARDS__', cards)
    out_path = os.path.join(root, 'docs', 'design', 'bamboo-cursors.html')
    io.open(out_path, 'w', encoding='utf-8').write(html)
    print('wrote %s' % os.path.normpath(out_path))


build_doc(css)
