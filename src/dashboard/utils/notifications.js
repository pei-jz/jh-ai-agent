// notifications — the transient success toast.
//
// Was a module-private function at the bottom of ConfigView.js, so it could only
// be used by Settings. It is here because the ConfigView shell it lived in is
// gone, and because a toast is not a settings concern.
//
// `textContent`, not innerHTML: the message is a caller-supplied string and this
// appends straight to <body>. Nothing has ever passed markup through it.

/**
 * Show a success toast for a few seconds.
 * @param {string} message
 * @param {Document} [doc] injectable for tests
 */
export function showNotification(message, doc = globalThis.document) {
    if (!doc?.body) return null;
    const el = doc.createElement('div');
    el.className = 'toast toast-success';

    const tick = doc.createElement('span');
    tick.textContent = '✓';
    const text = doc.createElement('span');
    text.textContent = String(message ?? '');
    el.append(tick, doc.createTextNode(' '), text);

    doc.body.appendChild(el);
    // A frame's grace before the opacity transition, so it animates in rather
    // than appearing already visible.
    setTimeout(() => { el.style.opacity = '1'; }, 50);
    setTimeout(() => {
        el.classList.add('toast-exit');
        setTimeout(() => el.remove(), 300);
    }, 3000);
    return el;
}
