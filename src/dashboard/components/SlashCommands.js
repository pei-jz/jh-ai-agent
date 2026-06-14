// SlashCommands — reusable "/" command popup (prompt templates + skills) that
// attaches to a <textarea>. Mirrors ChatView's behavior:
//   • Template → EXPANDS its prompt into the textarea (an editable starting point).
//   • Skill    → ATTACHES as a removable chip; its (fixed) body is injected at
//                SEND time via buildPrompt(), NOT dumped into the editable box —
//                skills are reusable capabilities, not per-use-edited text.
// The caller passes a chips container and calls `await sc.buildPrompt(text)` on send.

import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export class SlashCommands {
    /**
     * @param {HTMLTextAreaElement} textarea
     * @param {HTMLElement} popup   absolutely-positioned container for the list
     * @param {HTMLElement} [chips] container for attached-skill chips (optional)
     */
    constructor(textarea, popup, chips = null) {
        this.ta = textarea;
        this.popup = popup;
        this.chips = chips;
        this.items = [];
        this.index = 0;
        this.activeSkills = [];   // [{ name, title }]
        SlashCommands._ensureStyles();
        this._onInput = () => this._update();
        this._onKey = (e) => this._key(e);
        this._onBlur = () => setTimeout(() => this._hide(), 150);
        this.ta.addEventListener('input', this._onInput);
        this.ta.addEventListener('keydown', this._onKey);
        this.ta.addEventListener('blur', this._onBlur);
    }

    _update() {
        const v = this.ta.value;
        if (!v.startsWith('/')) { this._hide(); return; }
        const q = v.slice(1);
        const templates = promptTemplateManager.search(q).map(t => ({ type: 'template', key: t.key, label: t.label, icon: t.icon || '📝', prompt: t.prompt }));
        const skills = skillManager.search(q).map(s => ({ type: 'skill', key: s.name, label: s.title, icon: '⚡' }));
        this.items = [...templates, ...skills];
        this.index = 0;
        this._render();
    }

    _render() {
        if (this.items.length === 0) {
            this.popup.style.display = 'block';
            this.popup.innerHTML = `<div class="slash-popup-header">Commands</div><div class="slash-popup-empty">No matching template or skill</div>`;
            return;
        }
        const rows = this.items.map((it, i) => `
            <div class="slash-popup-item${i === this.index ? ' selected' : ''}" data-idx="${i}">
                <span class="slash-popup-icon">${it.icon}</span>
                <span class="slash-popup-key">/${esc(it.key)}</span>
                <span class="slash-popup-label">${esc(it.label)}</span>
                <span class="slash-popup-type">${it.type}</span>
            </div>`).join('');
        this.popup.style.display = 'flex';
        this.popup.innerHTML = `<div class="slash-popup-header">Commands — ↑↓ select, Enter confirm, Esc close</div><div class="slash-popup-list">${rows}</div>`;
        this.popup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._select(this.items[parseInt(el.getAttribute('data-idx'), 10)]);
            });
        });
        const sel = this.popup.querySelector('.slash-popup-item.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    _key(e) {
        if (this.popup.style.display === 'none' || !this.items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); this.index = Math.min(this.index + 1, this.items.length - 1); this._render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.index = Math.max(this.index - 1, 0); this._render(); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._select(this.items[this.index]); }
        else if (e.key === 'Escape') { e.preventDefault(); this._hide(); }
    }

    _select(item) {
        this._hide();
        if (!item) return;
        if (item.type === 'template') {
            // Expand the template prompt as an editable starting point.
            this.ta.value = item.prompt;
        } else {
            // Skill → attach a chip; strip the "/key" token, keep any text the
            // user typed after it. The body is injected at send (buildPrompt).
            const after = this.ta.value.slice(1);
            const sp = after.indexOf(' ');
            const remainder = sp >= 0 ? after.slice(sp + 1) : '';
            if (!this.activeSkills.some(s => s.name === item.key)) {
                this.activeSkills.push({ name: item.key, title: item.label || item.key });
            }
            this.ta.value = remainder;
            this._renderChips();
        }
        this.ta.style.height = 'auto';
        this.ta.focus();
    }

    /** Render removable chips for the attached skills. */
    _renderChips() {
        if (!this.chips) return;
        if (this.activeSkills.length === 0) { this.chips.style.display = 'none'; this.chips.innerHTML = ''; return; }
        this.chips.style.display = 'flex';
        this.chips.innerHTML = this.activeSkills.map(s => `
            <span class="sc-chip" data-name="${esc(s.name)}" title="Skill: ${esc(s.name)}">
                <span class="sc-chip-ico">⚡</span><span class="sc-chip-label">${esc(s.title)}</span>
                <button class="sc-chip-x" title="Remove">✕</button>
            </span>`).join('');
        this.chips.querySelectorAll('.sc-chip-x').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.closest('.sc-chip').getAttribute('data-name');
                this.activeSkills = this.activeSkills.filter(s => s.name !== name);
                this._renderChips();
            });
        });
    }

    /**
     * Build the final prompt: prepend each attached skill's body, then the user's
     * text. Mirrors ChatView's send-time skill injection. Async (reads bodies).
     */
    async buildPrompt(text) {
        const bodies = [];
        for (const s of this.activeSkills) {
            try {
                const body = await skillManager.readContent(s.name);
                bodies.push(`# Skill: ${s.title} (/${s.name})\n${body}`);
            } catch (e) { console.error('Failed to load skill:', s.name, e); }
        }
        const preamble = bodies.length ? bodies.join('\n\n') + '\n\n---\n\n' : '';
        return preamble + (text || '');
    }

    hasContent(text) { return !!(String(text || '').trim()) || this.activeSkills.length > 0; }

    _hide() { this.popup.style.display = 'none'; this.items = []; this.index = 0; }

    destroy() {
        this.ta.removeEventListener('input', this._onInput);
        this.ta.removeEventListener('keydown', this._onKey);
        this.ta.removeEventListener('blur', this._onBlur);
    }

    static _ensureStyles() {
        if (document.getElementById('slashcmd-styles')) return;
        const s = document.createElement('style');
        s.id = 'slashcmd-styles';
        s.textContent = `
            .slash-popup { position:absolute; bottom: calc(100% + 6px); left:0; right:0; background:var(--bg-secondary);
                border:1px solid var(--border-focus); border-radius:var(--radius-md); box-shadow:0 -4px 20px rgba(0,0,0,0.35);
                overflow:hidden; z-index:600; max-height:260px; display:flex; flex-direction:column; }
            .slash-popup-header { padding:6px 12px; font-size:11px; font-weight:600; color:var(--text-tertiary);
                text-transform:uppercase; letter-spacing:0.05em; background:var(--bg-tertiary); border-bottom:1px solid var(--border-light); }
            .slash-popup-list { overflow-y:auto; flex:1; }
            .slash-popup-item { display:flex; align-items:center; gap:10px; padding:8px 12px; cursor:pointer; font-size:13px; }
            .slash-popup-item:hover, .slash-popup-item.selected { background:var(--bg-hover); }
            .slash-popup-icon { font-size:16px; flex-shrink:0; }
            .slash-popup-key { font-family:var(--font-mono); font-size:12px; color:var(--accent); font-weight:600; min-width:80px; }
            .slash-popup-label { color:var(--text-secondary); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .slash-popup-type { font-size:10px; color:var(--text-tertiary); background:var(--bg-tertiary); border:1px solid var(--border-light);
                border-radius:3px; padding:1px 5px; flex-shrink:0; }
            .slash-popup-empty { padding:12px; text-align:center; font-size:12px; color:var(--text-tertiary); }
            .sc-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
            .sc-chip { display:inline-flex; align-items:center; gap:5px; background:hsla(265,90%,65%,0.12);
                border:1px solid hsla(265,90%,65%,0.45); color:var(--text-primary); border-radius:999px;
                padding:3px 8px; font-size:11.5px; font-weight:500; line-height:1.4; }
            .sc-chip-ico { font-size:11px; }
            .sc-chip-label { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .sc-chip-x { background:none; border:none; color:var(--text-tertiary); cursor:pointer; padding:0 0 0 2px; font-size:11px; line-height:1; }
            .sc-chip-x:hover { color:var(--error); }
        `;
        document.head.appendChild(s);
    }
}
