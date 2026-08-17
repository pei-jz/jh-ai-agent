// localMemory — the developer's OWN cross-workspace memory (P5).
//
// Contrast with workspaceMemory.test.js: that covers the per-project layer
// under `<workspace>/.agent/`; this covers the app-wide personal layer under
// the app config directory. The two must never share a file.

import { describe, it, expect } from 'vitest';
import {
    localMemoryPath, readLocalMemory, writeLocalMemory,
    addLocalMemoryEntry, localMemoryContext,
    LOCAL_MEMORY_MAX_ENTRIES, LOCAL_MEMORY_INJECT_MAX,
} from '../localMemory.js';

describe('localMemoryPath', () => {
    it('points into the app config dir, not any workspace', () => {
        expect(localMemoryPath('C:/Users/me/AppData/Roaming/jh-ai-agent'))
            .toBe('C:/Users/me/AppData/Roaming/jh-ai-agent/local_memory.json');
    });

    it('strips a trailing separator', () => {
        expect(localMemoryPath('C:/cfg/')).toBe('C:/cfg/local_memory.json');
    });
});

describe('readLocalMemory / writeLocalMemory', () => {
    it('round-trips entries through the invoke layer', async () => {
        let written = '';
        const wf = async (_cmd, args) => { written = args.content; };
        const rf = async (_cmd, args) => written;
        await writeLocalMemory('C:/cfg', [
            { text: 'Rust + Svelte', category: 'preference', score: 2 },
        ], wf);

        const out = await readLocalMemory('C:/cfg', rf);
        expect(out.entries).toHaveLength(1);
        expect(out.entries[0].text).toBe('Rust + Svelte');
    });

    it('registers the config dir as an allowed root before writing', async () => {
        const calls = [];
        const invoke = async (cmd, args) => { calls.push([cmd, args]); };
        await writeLocalMemory('C:/cfg', [], invoke);
        expect(calls[0][0]).toBe('set_allowed_roots');
        expect(calls[0][1].roots).toEqual(['C:/cfg']);
        expect(calls[1][0]).toBe('write_file');
    });

    it('a missing file reads as an empty store', async () => {
        const rf = async () => { throw new Error('no such file'); };
        const out = await readLocalMemory('C:/cfg', rf);
        expect(out).toEqual({ entries: [] });
    });

    it('drops corrupt lines and non-text entries', async () => {
        const rf = async () => '{"entries":[{"text":"ok"},{"text":"  "},{"nope":1},"junk"]}';
        const out = await readLocalMemory('C:/cfg', rf);
        expect(out.entries.map(e => e.text)).toEqual(['ok']);
    });

    it('a missing configDir is a safe no-op', async () => {
        const out = await readLocalMemory(null, async () => 'x');
        expect(out.entries).toEqual([]);
    });
});

describe('addLocalMemoryEntry', () => {
    it('appends a new entry with timestamps and a default category', () => {
        const out = addLocalMemoryEntry([], { text: 'prefer Japanese output' });
        expect(out).toHaveLength(1);
        expect(out[0].category).toBe('preference');
        expect(out[0].createdAt).toBeTruthy();
        expect(out[0].updatedAt).toBeTruthy();
    });

    it('bumps updatedAt on a near-duplicate instead of stacking a twin', () => {
        const first = addLocalMemoryEntry([], { text: 'same', category: 'pattern', score: 1 }, '2026-08-15T00:00:00.000Z');
        const second = addLocalMemoryEntry(first, { text: 'same', category: 'pattern', score: 5 }, '2026-08-15T00:00:01.000Z');
        expect(second).toHaveLength(1);
        expect(second[0].score).toBe(5);
        expect(second[0].updatedAt).not.toBe(first[0].updatedAt);
    });

    it('treats different categories as distinct entries', () => {
        const a = addLocalMemoryEntry([], { text: 'x', category: 'preference' });
        const b = addLocalMemoryEntry(a, { text: 'x', category: 'style' });
        expect(b).toHaveLength(2);
    });

    it('ignores blank text', () => {
        expect(addLocalMemoryEntry([], { text: '   ' })).toEqual([]);
    });

    it('caps the store at LOCAL_MEMORY_MAX_ENTRIES, dropping the lowest score', () => {
        let entries = [];
        for (let i = 0; i < LOCAL_MEMORY_MAX_ENTRIES + 5; i++) {
            entries = addLocalMemoryEntry(entries, { text: `entry ${i}`, score: i });
        }
        expect(entries).toHaveLength(LOCAL_MEMORY_MAX_ENTRIES);
        // The five lowest-score entries (0..4) were evicted.
        const texts = entries.map(e => e.text);
        expect(texts).not.toContain('entry 0');
        expect(texts).toContain(`entry ${LOCAL_MEMORY_MAX_ENTRIES + 4}`);
    });

    it('keeps the NEWEST entry when every score is the default (the common case)', () => {
        // Nothing sets a score today, so a full store must still accept new
        // memories — evicting the oldest, not the arrival itself.
        let entries = [];
        for (let i = 0; i < LOCAL_MEMORY_MAX_ENTRIES; i++) {
            entries = addLocalMemoryEntry(entries, { text: `entry ${i}` }, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`);
        }
        entries = addLocalMemoryEntry(entries, { text: 'brand new' }, '2026-01-02T00:00:00Z');
        const texts = entries.map(e => e.text);
        expect(entries).toHaveLength(LOCAL_MEMORY_MAX_ENTRIES);
        expect(texts).toContain('brand new');
        expect(texts).not.toContain('entry 0');
    });

    it('preserves insertion order when evicting', () => {
        let entries = [];
        for (let i = 0; i < LOCAL_MEMORY_MAX_ENTRIES + 1; i++) {
            entries = addLocalMemoryEntry(entries, { text: `entry ${i}` }, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`);
        }
        const nums = entries.map(e => Number(e.text.split(' ')[1]));
        expect(nums).toEqual([...nums].sort((a, b) => a - b));
    });
});

describe('localMemoryContext', () => {
    const sample = [
        { text: 'I write Rust and Svelte', category: 'preference', score: 1 },
        { text: 'commit messages in English', category: 'pattern', score: 2 },
        { text: 'Japanese user-facing replies', category: 'style', score: 3 },
    ];

    it('returns an empty string for an empty store', () => {
        expect(localMemoryContext([])).toBe('');
        expect(localMemoryContext(null)).toBe('');
    });

    it('renders a labelled block with a fixed shape', () => {
        const block = localMemoryContext(sample);
        expect(block).toContain('<developer_memory>');
        expect(block).toContain('[pattern] commit messages in English');
        expect(block).toContain('</developer_memory>');
    });

    it('ranks entries by relevance to the query', () => {
        const block = localMemoryContext(sample, 'how do I write my commit messages?');
        const rustAt = block.indexOf('Rust');
        const commitAt = block.indexOf('commit messages');
        expect(commitAt).toBeGreaterThan(-1);
        expect(commitAt).toBeLessThan(rustAt); // the query-matching entry comes first
    });

    it('caps the injected list at LOCAL_MEMORY_INJECT_MAX', () => {
        const many = Array.from({ length: LOCAL_MEMORY_INJECT_MAX + 3 }, (_, i) => ({
            text: `entry ${i}`, category: 'preference', score: i,
        }));
        const block = localMemoryContext(many);
        const shown = (block.match(/- \[preference\] entry \d+/g) || []).length;
        expect(shown).toBe(LOCAL_MEMORY_INJECT_MAX);
        expect(block).toContain('and 3 more');
    });
});
