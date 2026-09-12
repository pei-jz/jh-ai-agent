// @vitest-environment jsdom
//
// SlashCommands — the "/" popup shared by the task composer and the job forms.
//
// Two things pinned here, both about the helper talking to a framework that
// cannot see it work: that picking an item tells the textarea's listeners (a
// Svelte `bind:value` otherwise keeps the "/wiki" that was typed), and that a
// form can seed the chips it opens with.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));

const { SlashCommands } = await import('../SlashCommands.js');
const { promptTemplateManager } = await import('../../../modules/ai/PromptTemplateManager.js');

let ta, popup, chips;
beforeEach(() => {
    document.body.innerHTML = '';
    ta = document.createElement('textarea');
    popup = document.createElement('div');
    chips = document.createElement('div');
    document.body.append(popup, chips, ta);
    promptTemplateManager.loadFromConfig({ prompt_templates: { wiki: { label: 'wiki検索', prompt: 'wiki を検索して' } } });
});

function type(value) {
    ta.value = value;
    ta.dispatchEvent(new Event('input'));
}

describe('picking a template', () => {
    it('fires input, so a bound value sees the expansion', () => {
        new SlashCommands(ta, popup, chips);
        const seen = [];
        ta.addEventListener('input', () => seen.push(ta.value));

        type('/wiki');
        popup.querySelector('.slash-popup-item')
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(ta.value).toBe('wiki を検索して');
        // The last thing listeners heard is the template, not "/wiki".
        expect(seen.at(-1)).toBe('wiki を検索して');
    });
});

describe('setSkills', () => {
    it('draws the chips and reports through the same callback as a pick', () => {
        const onSkillsChange = vi.fn();
        const sc = new SlashCommands(ta, popup, chips, { onSkillsChange });

        sc.setSkills([{ name: 'daily', title: '日報の書き方' }, { name: 'bare' }]);

        const labels = [...chips.querySelectorAll('.sc-chip-label')].map(e => e.textContent);
        expect(labels).toEqual(['日報の書き方', 'bare']);
        expect(onSkillsChange).toHaveBeenLastCalledWith([
            { name: 'daily', title: '日報の書き方' }, { name: 'bare', title: 'bare' },
        ]);
    });

    it('clears the chips when given nothing', () => {
        const sc = new SlashCommands(ta, popup, chips);
        sc.setSkills([{ name: 'daily' }]);
        sc.setSkills([]);
        expect(chips.querySelectorAll('.sc-chip')).toHaveLength(0);
        expect(chips.style.display).toBe('none');
    });
});
