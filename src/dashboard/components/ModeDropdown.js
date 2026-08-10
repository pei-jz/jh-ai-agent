// ModeDropdown — a custom (non-native) dropdown for picking the agent mode.
//
// A native <select> can't render SVG icons or a per-row description, so this is
// a small custom widget: a button showing the current mode (SVG icon + name)
// and a popup list where each row shows the icon, name, AND its description, so
// the user understands the choice while selecting. Used by ChatView (agent mode
// bar) and the Monitor new-task modal.

import { AGENT_MODES, resolveModeId, DEFAULT_MODE_ID } from '../../modules/ai/AgentModes.js';
import { icon } from '../utils/icons.js';

// Mode id → SVG icon name (icons.js).
const MODE_ICON = { develop: 'code', research: 'search', automation: 'gear' };

/** Mode label without its leading emoji (we render an SVG icon instead). */
function modeName(mode) {
    return (mode.label || mode.id).replace(/^\S+\s+/, '');
}

export class ModeDropdown {
    constructor(selectedId, onChange) {
        this.selected = resolveModeId(selectedId || DEFAULT_MODE_ID);
        this.onChange = typeof onChange === 'function' ? onChange : () => {};
        this.id = 'mdd_' + Math.random().toString(36).slice(2, 8);
        this._docHandler = null;
    }

    get value() { return this.selected; }

    /** Returns the widget HTML (embed this where the <select> used to be). */
    render() {
        const m = AGENT_MODES[this.selected];
        const opts = Object.values(AGENT_MODES).map(mo => `
            <div class="mode-dd-opt ${mo.id === this.selected ? 'sel' : ''}" data-id="${mo.id}" role="option">
                <span class="mode-dd-ico">${icon(MODE_ICON[mo.id] || 'gear')}</span>
                <span class="mode-dd-texts">
                    <span class="mode-dd-name">${modeName(mo)}</span>
                    <span class="mode-dd-desc">${mo.description || ''}</span>
                </span>
            </div>`).join('');

        return `
            <div class="mode-dd" id="${this.id}">
                <button type="button" class="mode-dd-btn">
                    <span class="mode-dd-ico">${icon(MODE_ICON[this.selected] || 'gear')}</span>
                    <span class="mode-dd-cur">${modeName(m)}</span>
                    <span class="mode-dd-caret">▾</span>
                </button>
                <div class="mode-dd-list" role="listbox" style="display:none;">${opts}</div>
            </div>`;
    }

    /** Wire events. Call after the rendered HTML is in the DOM. */
    init() {
        ModeDropdown._ensureStyles();
        const root = document.getElementById(this.id);
        if (!root) return;
        const btn = root.querySelector('.mode-dd-btn');
        const list = root.querySelector('.mode-dd-list');

        const open = () => {
            list.style.display = 'block';
            this._docHandler = (e) => { if (!root.contains(e.target)) close(); };
            // Defer so the opening click itself doesn't immediately close it.
            setTimeout(() => document.addEventListener('mousedown', this._docHandler), 0);
        };
        const close = () => {
            list.style.display = 'none';
            if (this._docHandler) { document.removeEventListener('mousedown', this._docHandler); this._docHandler = null; }
        };

        btn.addEventListener('click', () => {
            if (list.style.display === 'block') close(); else open();
        });

        list.querySelectorAll('.mode-dd-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                const id = opt.getAttribute('data-id');
                this.selected = id;
                // Update the button face.
                root.querySelector('.mode-dd-cur').textContent = modeName(AGENT_MODES[id]);
                root.querySelector('.mode-dd-btn .mode-dd-ico').innerHTML = icon(MODE_ICON[id] || 'gear');
                list.querySelectorAll('.mode-dd-opt').forEach(o => o.classList.toggle('sel', o === opt));
                close();
                this.onChange(id);
            });
        });
    }

    destroy() {
        if (this._docHandler) { document.removeEventListener('mousedown', this._docHandler); this._docHandler = null; }
    }

    /** Inject the widget styles into <head> once (survives view re-renders). */
    static _ensureStyles() {
        if (document.getElementById('mode-dd-styles')) return;
        const style = document.createElement('style');
        style.id = 'mode-dd-styles';
        style.textContent = `
            .mode-dd { position: relative; }
            .mode-dd-btn {
                display: flex; align-items: center; gap: 7px; width: 100%;
                background: var(--bg-input); border: 1px solid var(--border);
                border-radius: var(--radius-sm); color: var(--text-primary);
                padding: 0 10px; height: 28px; font-size: 12px; cursor: pointer; outline: none;
            }
            .mode-dd-btn:hover { border-color: var(--border-focus); }
            .mode-dd-cur { flex: 1; text-align: left; white-space: nowrap; }
            .mode-dd-caret { opacity: 0.6; font-size: 10px; }
            .mode-dd-ico { display: inline-flex; color: var(--accent); }
            .mode-dd-list {
                position: absolute; top: calc(100% + 4px); left: 0; right: 0; min-width: 260px;
                background: var(--bg-secondary); border: 1px solid var(--border-focus);
                border-radius: var(--radius-md); box-shadow: 0 8px 28px rgba(0,0,0,0.45);
                z-index: 500; overflow: hidden; padding: 4px;
            }
            .mode-dd-opt {
                display: flex; align-items: flex-start; gap: 9px; padding: 8px 10px;
                border-radius: 6px; cursor: pointer;
            }
            .mode-dd-opt:hover { background: var(--bg-hover); }
            .mode-dd-opt.sel { background: var(--accent-glow-lg); }
            .mode-dd-opt .mode-dd-ico { margin-top: 1px; }
            .mode-dd-texts { display: flex; flex-direction: column; gap: 2px; }
            .mode-dd-name { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
            .mode-dd-desc { font-size: 11px; color: var(--text-tertiary); line-height: 1.4; }
        `;
        document.head.appendChild(style);
    }
}
