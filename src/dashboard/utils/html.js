// html — HTML escaping and URL vetting for the view layer.
//
// There were NINE `escapeHtml`/`esc` definitions across the dashboard, with FOUR
// different behaviours. Most escaped `& < > " '`; two omitted `'`; and
// `components/SlashCommands.js` escaped only `& < >` while interpolating into
// double-quoted attributes — so a skill file named `x" onmouseover="…` broke
// out of the attribute. Skills arrive from disk and are meant to be shareable, so
// that input is not as controlled as it looks.
//
// The stakes are higher here than in an ordinary web app: `withGlobalTauri` is
// on, so script that executes in this page reaches `window.__TAURI__.core.invoke`
// and therefore the filesystem and the shell. The CSP blocks inline script, which
// is the reason a divergent escaper has not already been an incident — but "the
// CSP catches it" is a second line of defence, not a first.
//
// One implementation, escaping the full set, used everywhere.

/**
 * Escape text for interpolation into HTML — element content OR a quoted
 * attribute value.
 *
 * Escapes all five: `&` first (so the others' entities are not double-escaped),
 * then `<` `>` `"` `'`. Both quote forms matter because call sites use both
 * `class="${…}"` and `title='${…}'`.
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        // `&#039;`, not `&#39;`: both are correct HTML, but the majority of the
        // replaced copies emitted the zero-padded form and tests pin it.
        .replace(/'/g, '&#039;');
}

/** Short alias — several views imported their local copy under this name. */
export const esc = escapeHtml;

/**
 * Schemes a link rendered from MODEL or TOOL output may point at.
 *
 * `renderMarkdown` turns `[text](url)` into `<a href="url">` with the url taken
 * verbatim from whatever the model wrote. `javascript:` there is a one-click path
 * to `window.__TAURI__` — currently stopped by the CSP, which is not a reason to
 * emit it. `data:` can carry a whole HTML document; `vbscript:` is the old IE
 * variant. Allow-list rather than deny-list, so a scheme nobody has thought of is
 * refused by default.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'file:']);

/**
 * Vet a URL for use in an `href`.
 *
 * @param {string} url raw, as written by the model
 * @returns {string} the url when its scheme is allowed, otherwise `'#'` — a
 *   harmless target that still renders as a link, so the surrounding text is not
 *   silently mangled by dropping the anchor.
 */
export function safeUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '#';
    // Same-document, relative and protocol-relative links carry no scheme, so
    // they cannot introduce `javascript:`.
    if (/^(#|\/|\.{1,2}\/)/.test(raw) || raw.startsWith('//')) return raw;
    // Anything else may carry an explicit scheme. Strip numeric entities and the
    // characters a browser ignores inside a scheme before testing: both
    // `java&#0;script:` and a tab-interrupted `javascript:` are read as
    // `javascript:`, and a regex over the raw string would pass them through.
    // Dropped by code point rather than by a character-class regex: the class
    // has to span the C0 controls, and writing that inline is exactly the kind
    // of literal that gets mangled the next time this line is edited.
    const probe = [...raw.replace(/&#x?[0-9a-f]+;?/gi, '')]
        .filter((ch) => {
            const code = ch.charCodeAt(0);
            return code > 32 && code !== 127;
        })
        .join('')
        .toLowerCase();
    const m = /^([a-z][a-z0-9+.-]*):/.exec(probe);
    if (!m) return raw;                       // no scheme => relative
    return SAFE_URL_SCHEMES.has(`${m[1]}:`) ? raw : '#';
}
