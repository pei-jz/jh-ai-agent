const ICONS = {
    overview: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="2" width="7" height="7" rx="1.5"/>
        <rect x="11" y="2" width="7" height="7" rx="1.5"/>
        <rect x="2" y="11" width="7" height="7" rx="1.5"/>
        <rect x="11" y="11" width="7" height="7" rx="1.5"/>
    </svg>`,
    chat: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 10c0 3.866-3.134 7-7 7a7.06 7.06 0 01-3.5-.928L3 17l.928-3.5A7.06 7.06 0 013 10c0-3.866 3.134-7 7-7s7 3.134 7 7z"/>
        <circle cx="7" cy="10" r="1" fill="currentColor" stroke="none"/>
        <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>
        <circle cx="13" cy="10" r="1" fill="currentColor" stroke="none"/>
    </svg>`,
    monitor: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="2,14 6,9 9,12 13,6 18,10"/>
        <line x1="2" y1="17" x2="18" y2="17"/>
    </svg>`,
    history: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="10" cy="10" r="7.5"/>
        <polyline points="10,5.5 10,10 13,12.5"/>
    </svg>`,
    schedule: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2.5" y="4" width="15" height="14" rx="1.5"/>
        <line x1="6" y1="2" x2="6" y2="6"/>
        <line x1="14" y1="2" x2="14" y2="6"/>
        <line x1="2.5" y1="9" x2="17.5" y2="9"/>
        <circle cx="10" cy="13.5" r="2.5"/>
        <polyline points="10,12.2 10,13.5 11,14.5"/>
    </svg>`,
    analytics: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="3" height="6" rx="1"/>
        <rect x="8.5" y="7" width="3" height="10" rx="1"/>
        <rect x="14" y="3" width="3" height="14" rx="1"/>
    </svg>`,
    config: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18.28 8.09 L18.28 11.91 L15.90 11.92 L15.52 12.81 L17.21 14.50 L14.50 17.21 L12.81 15.52 L11.92 15.90 L11.91 18.28 L8.09 18.28 L8.08 15.90 L7.19 15.52 L5.50 17.21 L2.79 14.50 L4.48 12.81 L4.10 11.92 L1.72 11.91 L1.72 8.09 L4.10 8.08 L4.48 7.19 L2.79 5.50 L5.50 2.79 L7.19 4.48 L8.08 4.10 L8.09 1.72 L11.91 1.72 L11.92 4.10 L12.81 4.48 L14.50 2.79 L17.21 5.50 L15.52 7.19 L15.90 8.08 Z"/>
        <circle cx="10" cy="10" r="2.7"/>
    </svg>`,
};

export class Sidebar {
    constructor(activeRoute, onNavigate) {
        this.activeRoute = activeRoute;
        this.onNavigate = onNavigate;
    }

    render() {
        const items = [
            { id: 'overview',   label: 'Overview',   icon: ICONS.overview },
            { id: 'chat',       label: 'Chat',        icon: ICONS.chat },
            { id: 'monitor',    label: 'Monitor',     icon: ICONS.monitor },
            { id: 'schedule',   label: 'Schedule',    icon: ICONS.schedule },
            { id: 'config',     label: 'Settings',    icon: ICONS.config },
        ];

        const navHtml = items.map(item => `
            <div class="sidebar-item ${this.activeRoute === item.id ? 'active' : ''}"
                 data-route="${item.id}"
                 data-tooltip="${item.label}">
                <span class="sidebar-item-icon">${item.icon}</span>
            </div>
        `).join('');

        return `
            <style>
                .sidebar-item-icon svg {
                    width: 20px;
                    height: 20px;
                    display: block;
                }
                .sidebar-item.active .sidebar-item-icon svg {
                    stroke: var(--accent);
                }
                .sidebar-item:hover:not(.active) .sidebar-item-icon svg {
                    stroke: var(--text-primary);
                }
            </style>
            <div class="sidebar">
                <div class="sidebar-logo" data-tooltip="JH Agent">
                    <svg class="sidebar-logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px;stroke:var(--accent)">
                        <circle cx="12" cy="8" r="4"/>
                        <path d="M6 20v-1a6 6 0 0112 0v1"/>
                        <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none"/>
                        <path d="M9 8h1M14 8h1" stroke-width="1.2"/>
                    </svg>
                </div>
                <nav class="sidebar-nav">
                    ${navHtml}
                </nav>
                <div class="sidebar-footer">
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
