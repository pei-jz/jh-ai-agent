// Sidebar — the primary nav rail.
//
// There is no logo at the top. A product mark earns its space when it tells
// somebody where they are — on a single-window desktop app you already launched,
// it tells you nothing, and it was costing a 56px slot plus a divider at the one
// place on screen where the eye lands first. The rail starts with the first
// destination instead.
//
// Icon design rules, so the set stays coherent as items are added:
//
//   • ONE 20×20 grid, one stroke weight (1.6), round caps and joins. A glyph
//     drawn on a different grid reads as a different size even when the box
//     matches, which is what made the old set look assembled rather than drawn.
//   • Optical size ~15 of 20. The old overview glyph filled 16 and the monitor
//     glyph filled 9, so the rail looked like it had two icon sizes in it.
//   • Three elements maximum. At 20px a fourth element turns into grey mush —
//     the old schedule icon (frame + rule + two hangers + inset clock + clock
//     hands) was the worst offender.
//   • Every glyph owns a closed shape in `.ic-fill`, which the active state
//     tints. Colour alone is a weak selection cue on a 64px rail, especially in
//     the light theme where accent-on-grey is a small contrast step.
//
// The gear path is machine-generated (6 teeth, tip r=8.3, root r=6.3): a
// hand-plotted polygon is what the previous 8-tooth cog was, and its teeth were
// uneven enough to see at 20px. Six teeth, not eight — at this size fewer and
// larger survives rasterization.

import { getAppVersion } from '../../modules/ai/appVersion.js';

const ICONS = {
    // Memory — a head in profile with a filled core: what is retained, not a
    // database and not a lightbulb. Three elements, like every other glyph.
    memory: `
        <g class="ic-fill">
            <path d="M10 2.6c-2.4 0-4 1.45-4 3.3 0 .58-.32.9-.85 1.22C4.05 7.78 3.4 8.78 3.4 10s.65 2.2 1.7 2.8c.5.3.8.62.8 1.2 0 1.78 1.55 3.2 4.1 3.2s4.1-1.42 4.1-3.2c0-.58.3-.9.8-1.2 1.05-.6 1.7-1.58 1.7-2.8s-.65-2.22-1.75-2.88c-.53-.32-.85-.64-.85-1.22 0-1.85-1.6-3.3-4-3.3z"/>
        </g>
        <path d="M10 2.8v14.4"/>`,

    // Monitor — a screen with a live pulse. The bare sparkline it replaces was
    // both too small and too close to a chart, which is Analytics' job.
    monitor: `
        <g class="ic-fill"><rect x="2.3" y="3.6" width="15.4" height="12.8" rx="2.4"/></g>
        <path d="M5.2 10h2.1l1.5-3.1 2.3 6.2 1.4-3.1h2.3"/>`,

    // Schedule — calendar. One filled day marker instead of an inset clock:
    // "a date that is set" is the meaning, and it survives at 20px.
    schedule: `
        <g class="ic-fill"><rect x="2.4" y="4.1" width="15.2" height="13.5" rx="2.3"/></g>
        <path d="M2.4 8.3h15.2"/>
        <path d="M6.6 2.4v3.4M13.4 2.4v3.4"/>
        <circle cx="10" cy="12.8" r="1.5" fill="currentColor" stroke="none"/>`,

    // Usage — a sheet with two bars. Not a pie (unreadable at 20px) and not a
    // coin (this is a breakdown, not a balance).
    report: `
        <g class="ic-fill"><rect x="3.4" y="2.5" width="13.2" height="15" rx="2.2"/></g>
        <path d="M7 13.4V9.6M10 13.4V6.9M13 13.4v-2.6"/>`,

    // Settings — a real 6-tooth gear (generated), with a hub.
    config: `
        <g class="ic-fill">
            <path d="M7.64 4.16 L7.85 1.98 L12.15 1.98 L12.36 4.16 L13.88 5.04 L15.87 4.13 L18.02 7.85 L16.24 9.12 L16.24 10.88 L18.02 12.15 L15.87 15.87 L13.88 14.96 L12.36 15.84 L12.15 18.02 L7.85 18.02 L7.64 15.84 L6.12 14.96 L4.13 15.87 L1.98 12.15 L3.76 10.88 L3.76 9.12 L1.98 7.85 L4.13 4.13 L6.12 5.04 Z"/>
        </g>
        <circle cx="10" cy="10" r="2.6"/>`,
};

// The product mark. A hexagon (chip / shield) around a spark: the old glyph was
// a generic user avatar, which said "account", not "agent" — and it was the one
// thing on screen that could not be mistaken for part of the nav.
// The rail's PRIMARY destinations — the places you move between while working.
export const NAV_ITEMS = [
    // "Work", not "Monitor": you START things here as well as watch them — the
    // composer moved into it and Chat folded into it as a mode.
    // docs/design/information-architecture.md §2.
    { id: 'monitor',  label: 'Work',     icon: 'monitor' },
    // What the agent has learned. Its own destination since step 4 — it used to
    // be a tab in a pane that swapped away whenever a run started.
    { id: 'memory',   label: 'Memory',   icon: 'memory' },
    // Consulted rather than worked in, but consulting it should not mean
    // opening the settings drawer. See views/UsageView.js.
    { id: 'usage',    label: 'Usage',    icon: 'report' },
    { id: 'schedule', label: 'Schedule', icon: 'schedule' },
];

// Settings is not one of them. It is where you go to change how the app behaves
// and then leave again — a different kind of destination, visited a fraction as
// often. Grouping it with the version in the footer says that: everything above
// the rule is the work, everything below it is the app itself.
export const FOOTER_ITEMS = [
    { id: 'config', label: 'Settings', icon: 'config' },
];

export class Sidebar {
    constructor(activeRoute, onNavigate) {
        this.activeRoute = activeRoute;
        this.onNavigate = onNavigate;
    }

    render() {
        const svg = (body) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

        // A <button> with a real accessible name and a VISIBLE label.
        //
        // Two problems, one fix. The rail was a set of <div>s with click
        // handlers: no tabindex, no role, no aria-label — so the app's primary
        // navigation could not be reached by keyboard at all and a screen reader
        // announced nothing (Report_20260829.md B9). And with the destination
        // count where it is, an icon-only rail asks the user to learn a glyph
        // set to move around a five-screen app; the tooltip was the only label,
        // and a tooltip is not a label, it is a reminder.
        //
        // `aria-current="page"` rather than a class alone: the active state has
        // to be perceivable without colour, which is a weak cue on a narrow rail
        // and weaker still under the paper themes.
        const itemHtml = (item, index) => `
            <button type="button"
                 class="sidebar-item ${this.activeRoute === item.id ? 'active' : ''}"
                 data-route="${item.id}"
                 ${this.activeRoute === item.id ? 'aria-current="page"' : ''}
                 title="${item.label}${index != null ? ` (Ctrl+${index + 1})` : ''}">
                <span class="sidebar-item-icon">${svg(ICONS[item.icon])}</span>
                <span class="sidebar-item-label">${item.label}</span>
            </button>
        `;
        const navHtml = NAV_ITEMS.map((it, i) => itemHtml(it, i)).join('');
        const footerHtml = FOOTER_ITEMS.map(it => itemHtml(it, null)).join('');

        return `
            <style>
                .sidebar-item-label {
                    font-size: 9.5px;
                    letter-spacing: 0.04em;
                    line-height: 1;
                    color: inherit;
                }
                .sidebar-item-icon svg {
                    width: 20px;
                    height: 20px;
                    display: block;
                    /* The tint is applied to .ic-fill only; a stroke-only glyph
                       filled wholesale turns into a blob. */
                    fill: none;
                    transition: opacity var(--transition-fast);
                }
                .sidebar-item-icon .ic-fill { fill: transparent; transition: fill var(--transition-fast); }
                .sidebar-item.active .sidebar-item-icon svg { stroke: var(--accent); }
                /* A wash, not a solid: the glyph must still read as line art, and
                   the stroke has to stay legible on top of its own fill. */
                .sidebar-item.active .sidebar-item-icon .ic-fill { fill: var(--accent-surface); }
                .sidebar-item:hover:not(.active) .sidebar-item-icon svg { stroke: var(--ink); }
            </style>
            <div class="sidebar">
                <nav class="sidebar-nav">
                    ${navHtml}
                </nav>
                <div class="sidebar-footer">
                    ${footerHtml}
                    <span class="sidebar-version"></span>
                </div>
            </div>
        `;
    }

    init() {
        document.querySelectorAll('.sidebar-item').forEach(item => {
            item.addEventListener('click', () => {
                const route = item.getAttribute('data-route');
                if (route && this.onNavigate) {
                    this.onNavigate(route);
                }
            });
        });

        // Ctrl/⌘ + 1..N for the primary destinations. Held on the instance so a
        // re-render (every route change builds a new Sidebar) releases the old
        // one instead of stacking a listener per navigation.
        if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
        this._keyHandler = (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
            const n = Number(e.key);
            if (!Number.isInteger(n) || n < 1 || n > NAV_ITEMS.length) return;
            // Ctrl+N is the new-task shortcut inside Work; digits are free.
            e.preventDefault();
            this.onNavigate?.(NAV_ITEMS[n - 1].id);
        };
        document.addEventListener('keydown', this._keyHandler);

        // The version is resolved from the runtime (Cargo.toml) rather than
        // hard-coded — see modules/ai/appVersion.js. Render an empty span first
        // and fill it once resolved, so the footer never shows a stale literal.
        getAppVersion().then(v => {
            const el = document.querySelector('.sidebar-version');
            if (el) el.textContent = `v${v}`;
        }).catch(() => {});
    }
}
