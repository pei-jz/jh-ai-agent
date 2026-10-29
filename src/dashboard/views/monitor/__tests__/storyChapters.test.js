import { describe, it, expect } from 'vitest';
import {
    commandRole, lineAction, isAnnouncement, toStoryChapters, chapterTally, toolVerbRole,
} from '../storyChapters.js';

let seq = 0;
const read = (path) => ({ type: 'tool', tool: 'read_file', path, text: `✓ read_file: ${path}` });
const grep = (q) => ({ type: 'tool', tool: 'grep_search', text: `✓ grep_search: ${q}` });
const write = (path) => ({ type: 'tool', tool: 'apply_patch', path, write: true, text: `✓ apply_patch: ${path}` });
const cmd = (c, ok = true) => ({ type: ok ? 'tool' : 'error', tool: 'run_command', command: c, text: `✓ run_command: ${c}` });
const group = (head, ...lines) => ({ id: `g${++seq}`, rev: 1, kind: 'group', head: { type: 'thought', text: head }, lines, at: seq * 1000 });
const request = (text = 'fix it') => ({ id: `r${++seq}`, kind: 'request', text });
const roles = (out) => out.filter(i => i.kind === 'phase').map(i => i.role);

describe('commandRole — a command is placed by what it is for', () => {
    it('tells checking, changing and looking apart', () => {
        expect(commandRole('npm test')).toBe('verify');
        expect(commandRole('npm run build')).toBe('verify');
        expect(commandRole('cargo check')).toBe('verify');
        expect(commandRole('node --check a.js')).toBe('verify');
        expect(commandRole('npm install lodash')).toBe('change');
        expect(commandRole('git mv a b')).toBe('change');
        expect(commandRole('Remove-Item x')).toBe('change');
        expect(commandRole('git grep foo')).toBe('investigate');
        expect(commandRole('git log -5')).toBe('investigate');
        expect(commandRole('Get-Content a.txt')).toBe('investigate');
    });
    it('returns null for a command it cannot place', () => {
        expect(commandRole('python script.py')).toBe(null);
        expect(commandRole('')).toBe(null);
    });
    it('reads the command back out of the line text when the field is missing', () => {
        expect(lineAction({ tool: 'run_command', text: '✓ run_command: npm test' }).role).toBe('verify');
    });
});

describe('isAnnouncement — "let me read X" is not a finding', () => {
    it('drops announcements', () => {
        expect(isAnnouncement('configForm.js を確認します。')).toBe(true);
        expect(isAnnouncement('まずテストを見る')).toBe(true);
        expect(isAnnouncement('Let me read the config file')).toBe(true);
        expect(isAnnouncement('💭 I\'ll search for the handler')).toBe(true);
    });
    it('keeps findings', () => {
        expect(isAnnouncement('1回目のクリックは blur で dirty を立てるだけで、送信まで届いていなかった。')).toBe(false);
        expect(isAnnouncement('The submit handler runs before the dirty flag is set.')).toBe(false);
    });
});

describe('toStoryChapters — steps become chapters', () => {
    it('reads, a decision, a change: one chapter per role, in order', () => {
        const items = [
            request(),
            group('Let me look at the form', read('a.js'), read('b.js'), grep('dirty')),
            group('The dirty flag is only set on blur, so the first click never submits.', read('c.js')),
            group('Fix it', write('a.js')),
        ];
        const out = toStoryChapters(items);
        expect(out[0].kind).toBe('request');
        expect(roles(out)).toEqual(['investigate', 'change']);
        const inv = out[1];
        expect(inv.reads.map(f => f.base)).toEqual(['a.js', 'b.js', 'c.js']);
        expect(inv.searches).toBe(1);
        // The finding, not the announcement, is the prose.
        expect(inv.summary).toMatch(/only set on blur/);
    });

    it('investigate → change → investigate (with a command) keeps the order', () => {
        const items = [
            group('look', read('a.js'), read('b.js'), read('c.js')),
            group('change', write('a.js')),
            group('look again', read('d.js'), cmd('git grep dirty')),
        ];
        expect(roles(toStoryChapters(items))).toEqual(['investigate', 'change', 'investigate']);
    });

    it('a command it cannot place joins the chapter it is in', () => {
        const items = [group('look', read('a.js'), cmd('python probe.py'), grep('x'))];
        const out = toStoryChapters(items);
        expect(roles(out)).toEqual(['investigate']);
        expect(out[0].commands).toEqual(['python probe.py']);
    });

    it('a glance right before a change is part of the change', () => {
        const items = [
            group('check it', read('a.js')),
            group('edit', write('a.js')),
        ];
        const out = toStoryChapters(items);
        expect(roles(out)).toEqual(['change']);
        expect(out[0].checkedFirst).toBe(true);
        expect(out[0].reads.map(f => f.base)).toEqual(['a.js']);
    });

    it('change ↔ verify round trips fold into one chapter with the last outcome', () => {
        const items = [
            group('edit', write('a.js')),
            group('test', cmd('npm test', false)),
            group('edit again', write('a.js')),
            group('test again', cmd('npm test')),
        ];
        const out = toStoryChapters(items);
        expect(roles(out)).toEqual(['loop']);
        expect(out[0].rounds).toBe(2);
        expect(out[0].lastFailed).toBe(false);
    });

    it('a single change then verify stays two chapters', () => {
        const items = [group('edit', write('a.js')), group('test', cmd('npm test'))];
        expect(roles(toStoryChapters(items))).toEqual(['change', 'verify']);
    });

    it('questions and results close the chapter before them', () => {
        const ask = { id: 'ask1', kind: 'ask', text: 'ok?' };
        const items = [group('look', read('a.js'), read('b.js'), read('c.js')), ask, group('edit', write('a.js'))];
        const out = toStoryChapters(items);
        expect(out.map(i => i.kind)).toEqual(['phase', 'ask', 'phase']);
    });

    it('only the last chapter of a live run is live; it shows "now" and no prose yet', () => {
        const items = [
            group('The cause is the blur handler, confirmed in two places.', read('a.js'), read('b.js'), read('e.js')),
            group('edit', write('a.js')),
            group('Let me run the tests', cmd('npm test')),
        ];
        const out = toStoryChapters(items, { live: true });
        const phases = out.filter(i => i.kind === 'phase');
        expect(phases.map(p => p.live)).toEqual([false, false, true]);
        expect(phases[2].summary).toBe('');
        expect(phases[2].now).toMatch(/npm test/);
        expect(phases[0].summary).toMatch(/blur handler/);
    });

    it('reasoning with no action becomes a "think" chapter', () => {
        const nar = { id: 'n1', kind: 'narration', text: 'Thinking about the approach in detail here.' };
        expect(roles(toStoryChapters([nar]))).toEqual(['think']);
    });

    it('returns the SAME object for an unchanged chapter when given a cache', () => {
        const items = [group('look', read('a.js'), read('b.js'), read('c.js')), request()];
        const cache = new Map();
        const a = toStoryChapters(items, { cache });
        const b = toStoryChapters(items, { cache });
        expect(b[0]).toBe(a[0]);
    });

    it('a thinking-only chapter that grows is NOT served stale from the cache', () => {
        const cache = new Map();
        const a = [group('first thought here')];
        toStoryChapters(a, { cache });
        const b = toStoryChapters([...a, group('second thought here')], { cache });
        expect(b[0].trace).toHaveLength(2);
    });

    it('a bare tool line with no structured target still lands in a chapter', () => {
        const bare = { id: 'a1', kind: 'activity', type: 'tool', text: 'read_file: a.js' };
        expect(roles(toStoryChapters([bare]))).toEqual(['investigate']);
    });

    it('a progress status ("Reading file: x…") is never the prose', () => {
        expect(isAnnouncement('Reading file: C:/x/brand/brand.json...')).toBe(true);
        expect(isAnnouncement('独立レビューを実行中… / Independent sub-agent review…')).toBe(true);
    });

    it('the review gate is a "checked" chapter, and its verdict closes it', () => {
        const items = [
            group('edit', write('deck.html')),
            group('🔎 独立レビューを実行中… / Independent sub-agent review…'),
            { id: 'sub1', kind: 'activity', type: 'tool', tool: 'read_file', path: 'deck.html', text: '🤖 [sub:reviewer#1] ✓ read_file: deck.html' },
            group('🔎 レビューPASS ✅'),
        ];
        const out = toStoryChapters(items);
        expect(roles(out)).toEqual(['change', 'verify']);
        expect(out[1].summary).toMatch(/PASS/);
    });

    it('labels same-named files by their folder', () => {
        const [ch] = toStoryChapters([group('look', read('brand/README.md'), read('docs/README.md'), read('a.js'))]);
        expect(ch.reads.map(f => f.label)).toEqual(['brand/README.md', 'docs/README.md', 'a.js']);
    });

    it('an app tool is placed by its verb', () => {
        expect(toolVerbRole('create_deck')).toBe('change');
        expect(toolVerbRole('write_deck')).toBe('change');
        expect(toolVerbRole('audit_deck')).toBe('verify');
        expect(toolVerbRole('screenshot_deck')).toBe('verify');
        expect(toolVerbRole('get_guide')).toBe('investigate');
        expect(toolVerbRole('mcp__jh-presentation__list_decks')).toBe('investigate');
        expect(toolVerbRole('task_progress')).toBe(null);
        expect(toolVerbRole('ask_user')).toBe(null);
    });

    it('a deck build moves through chapters as its tools change', () => {
        const mcp = (tool) => ({ type: 'tool', tool, text: `✓ ${tool}` });
        const items = [
            group('look', mcp('get_guide'), mcp('list_decks'), read('a.html')),
            group('make', mcp('create_deck'), mcp('write_deck'), mcp('write_deck')),
            group('check', mcp('audit_deck'), mcp('screenshot_deck')),
        ];
        const out = toStoryChapters(items);
        expect(roles(out)).toEqual(['investigate', 'change', 'verify']);
        expect(chapterTally(out[1], (k, p) => `${k}:${p.n}`)).toEqual(['create_deck', 'write_deck ×2']);
    });

    it('Test-Path is not a test run', () => {
        expect(commandRole("$d = Join-Path $env:TEMP 'x'; if (Test-Path $d) { }")).not.toBe('verify');
    });

    it('a chapter with nothing to show is the lead-in to the next, not its own', () => {
        const tp = { type: 'tool', tool: 'task_progress', text: '✓ task_progress' };
        const out = toStoryChapters([group('Plan the work', tp), group('look', read('a.js'), grep('x'))]);
        expect(roles(out)).toEqual(['investigate']);
    });

    it('the closing report streamed as prose is never a chapter summary', () => {
        const nar = { id: 'n9', kind: 'narration', text: '新規デッキを作成しました。 ## 作成したもの deck.html' };
        const out = toStoryChapters([group('edit', write('deck.html')), nar, group('t', cmd('npm test'))]);
        expect(out.every(c => !/作成したもの/.test(c.summary || ''))).toBe(true);
    });

    it('a tool’s "finished:" status echo is never a chapter’s prose', () => {
        const nar = { id: 'n8', kind: 'narration', text: '✅ run_command finished: 2026-10-28 06:08:18 (水曜日)' };
        const out = toStoryChapters([group('look', read('docs/downloads.md')), nar]);
        expect(out.every(c => !/finished/.test(c.summary || ''))).toBe(true);
        expect(isAnnouncement('run_command finished: 2026-10-28')).toBe(true);
    });

    it('chapterTally counts what the chapter did', () => {
        const [ch] = toStoryChapters([group('look', read('a.js'), read('b.js'), read('c.js'), grep('x'))]);
        expect(chapterTally(ch, (k, p) => `${k}:${p.n}`)).toEqual(['story.tally.reads:3', 'story.tally.searches:1']);
    });
});
