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

const ICONS = {
    // Dashboard — a bento of panels, asymmetric so it is not "the apps grid".
    overview: `
        <g class="ic-fill">
            <rect x="2.5" y="2.5" width="6.4" height="15" rx="1.8"/>
            <rect x="11.1" y="2.5" width="6.4" height="6" rx="1.8"/>
            <rect x="11.1" y="11.5" width="6.4" height="6" rx="1.8"/>
        </g>`,

    // Chat — a bubble with two text lines. The old three dots read as "typing…",
    // which is a state, not a place you navigate to.
    chat: `
        <g class="ic-fill">
            <path d="M17.5 9.6c0 3.65-3.36 6.6-7.5 6.6-.93 0-1.82-.15-2.64-.42L3 17.5l1.62-3.7A6.24 6.24 0 012.5 9.6C2.5 5.95 5.86 3 10 3s7.5 2.95 7.5 6.6z"/>
        </g>
        <path d="M6.9 8.3h6.2M6.9 11.1h3.8"/>`,

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
    { id: 'overview', label: 'Overview', icon: 'overview' },
    { id: 'chat',     label: 'Chat',     icon: 'chat' },
    { id: 'monitor',  label: 'Monitor',  icon: 'monitor' },
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

        const itemHtml = (item) => `
            <div class="sidebar-item ${this.activeRoute === item.id ? 'active' : ''}"
                 data-route="${item.id}"
                 data-tooltip="${item.label}">
                <span class="sidebar-item-icon">${svg(ICONS[item.icon])}</span>
            </div>
        `;
        const navHtml = NAV_ITEMS.map(itemHtml).join('');
        const footerHtml = FOOTER_ITEMS.map(itemHtml).join('');

        return `
            <style>
                .sidebar-item-icon svg {
                    width: 21px;
                    height: 21px;
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
                .sidebar-item.active .sidebar-item-icon .ic-fill { fill: var(--accent-glow-lg, var(--accent-glow)); }
                .sidebar-item:hover:not(.active) .sidebar-item-icon svg { stroke: var(--text-primary); }
            </style>
            <div class="sidebar">
                <nav class="sidebar-nav">
                    ${navHtml}
                </nav>
                <div class="sidebar-footer">
                    ${footerHtml}
                    <span class="sidebar-version">v0.1</span>
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
    }
}
