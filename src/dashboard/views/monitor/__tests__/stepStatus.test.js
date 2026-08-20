// stepStatus — the step-header label rules, without the DOM they were buried in.

import { describe, it, expect, vi } from 'vitest';
import { stepStatusFor, nextStepStatus, statusClass, STATUS_PRIORITY } from '../stepStatus.js';

const deps = {
    summarizeThought: (raw) => `SUM(${String(raw).slice(0, 12)})`,
    toolActionLabel: (d) => `✓ ${d.name} → ${d.request?.path || d.request?.command || ''}`.trim(),
    toolTarget: (name, args) => ({ name, args }),
};
const pkt = (event, data = {}) => ({ event, data });

describe('a thought', () => {
    it('summarises it and remembers the summary for later', () => {
        const s = stepStatusFor(pkt('thought', { text: 'I will read the config first' }), {}, deps);
        expect(s).toMatchObject({ type: 'thought', text: 'SUM(I will read )' });
        expect(s.remember).toEqual({ thoughtSummary: 'SUM(I will read )' });
    });

    it('serialises a structured thought rather than showing [object Object]', () => {
        const s = stepStatusFor(pkt('thought', { text: { plan: 'x' } }), {}, deps);
        expect(s.text).toContain('SUM({"plan"');
    });
});

describe('a tool starting', () => {
    // `tool_call` fires ONCE, at start; completion arrives separately. Reading it
    // as "done" showed a finished label while the tool was still running.
    it('reads as running, not as finished', () => {
        const s = stepStatusFor(pkt('tool_call', { name: 'read_file', args: { path: 'a.js' } }), {}, deps);
        expect(s.text).toBe('⚙ Running: read_file → a.js…');
        expect(s.type).toBe('tool');
    });

    it('carries the target so the inspector knows what was touched', () => {
        const s = stepStatusFor(pkt('tool_call', { name: 'run_command', args: { command: 'npm t' } }), {}, deps);
        expect(s.target).toEqual({ name: 'run_command', args: { command: 'npm t' } });
        expect(s.remember).toEqual({ lastTool: 'run_command' });
    });

    it('shows WHAT the tool acts on, not just its name', () => {
        const s = stepStatusFor(pkt('tool_call', { name: 'edit_file', args: { path: 'src/x.rs' } }), {}, deps);
        expect(s.text).toContain('src/x.rs');
    });
});

describe('a tool finishing', () => {
    const done = (over = {}) => pkt('log', { method: 'TOOL', name: 'read_file', request: { path: 'a.js' }, ...over });

    // The header should say what the step ACHIEVED, not that some tool returned.
    it('prefers the step thought over a bare "done"', () => {
        const s = stepStatusFor(done(), { thoughtSummary: 'Checked the config' }, deps);
        expect(s.text).toBe('Checked the config');
    });

    it('falls back to past tense when no thought was captured', () => {
        expect(stepStatusFor(done(), {}, deps).text).toBe('✓ read_file done');
    });

    it('falls back to the remembered tool name when the event carries none', () => {
        expect(stepStatusFor(done({ name: undefined }), { lastTool: 'grep_search' }, deps).text)
            .toBe('✓ grep_search done');
    });

    // Putting the thought in both places duplicated it directly under its own
    // "⚙ Running: X…" line.
    it('gives the feed the tool action rather than repeating the header', () => {
        const s = stepStatusFor(done(), { thoughtSummary: 'Checked the config' }, deps);
        expect(s.feed).toBe('✓ read_file → a.js');
        expect(s.feed).not.toBe(s.text);
    });

    // The forwarded "🤖 [sub:…]" line already says what the child is doing;
    // echoing the parent's thought repeated one sentence after every child tool.
    it('shows a SUB-AGENT tool its own action, not the parent thought', () => {
        for (const label of ['🤖 [worker] step', 'sub:reviewer']) {
            const s = stepStatusFor(done({ stepLabel: label }), { thoughtSummary: 'PARENT THOUGHT' }, deps);
            expect(s.text).toBe('✓ read_file → a.js');
            expect(s.text).not.toContain('PARENT THOUGHT');
        }
    });
});

describe('other events', () => {
    it('marks an awaited approval', () => {
        expect(stepStatusFor(pkt('confirm_request', {}), {}, deps))
            .toMatchObject({ text: '⏸ Awaiting approval…', type: 'confirm' });
    });

    it('marks a recoverable error as recovering', () => {
        expect(stepStatusFor(pkt('error', { error: 'boom' }), {}, deps))
            .toMatchObject({ text: '⚠ Error — recovering', type: 'error' });
    });

    it('surfaces a retry status', () => {
        expect(stepStatusFor(pkt('status', { message: 'Retrying generation' }), {}, deps))
            .toMatchObject({ text: '↻ Retrying generation', type: 'error' });
    });

    // Without this the feed goes silent while children work — the parent emits no
    // events of its own — and the thinking placeholder lingers over nothing.
    it('surfaces sub-agent and review-gate progress', () => {
        expect(stepStatusFor(pkt('status', { message: '🤖 [sub:coder] editing' }), {}, deps).text)
            .toBe('🤖 [sub:coder] editing');
        expect(stepStatusFor(pkt('status', { message: '🔎 reviewing' }), {}, deps).type).toBe('tool');
    });

    it('says nothing for an ordinary status or an unrelated event', () => {
        expect(stepStatusFor(pkt('status', { message: 'Saving memory' }), {}, deps)).toBeNull();
        expect(stepStatusFor(pkt('status', {}), {}, deps)).toBeNull();
        expect(stepStatusFor(pkt('token_usage', { prompt_tokens: 1 }), {}, deps)).toBeNull();
        expect(stepStatusFor(pkt('log', { method: 'CHAT' }), {}, deps)).toBeNull();
    });

    it('survives a malformed packet', () => {
        expect(stepStatusFor(null, {}, deps)).toBeNull();
        expect(stepStatusFor({}, {}, deps)).toBeNull();
    });

    it('works without any injected helpers', () => {
        const s = stepStatusFor(pkt('log', { method: 'TOOL', name: 'x' }), {});
        expect(s.text).toBe('✓ x done');
        expect(vi.isMockFunction(s.text)).toBe(false);
    });
});

describe('nextStepStatus', () => {
    const of = (type, text = type) => ({ type, text });

    // A step emits several things at once and the header has room for one.
    it('lets a stronger claim take the header', () => {
        expect(nextStepStatus(of('live'), of('tool'))).toMatchObject({ type: 'tool' });
        expect(nextStepStatus(of('tool'), of('error'))).toMatchObject({ type: 'error' });
    });

    it('lets an equal claim refresh the text', () => {
        expect(nextStepStatus(of('tool', 'first'), of('tool', 'second')).text).toBe('second');
    });

    it('keeps the stronger one when a weaker event arrives after it', () => {
        expect(nextStepStatus(of('error'), of('live'))).toMatchObject({ type: 'error' });
    });

    // Once a step is summarised, a late live event must not put "Calling LLM…"
    // back on a step that has already finished.
    it('never overwrites a finalised step', () => {
        expect(nextStepStatus(of('final', 'Did the thing'), of('error')).text).toBe('Did the thing');
    });

    it('accepts the first label whatever it is', () => {
        expect(nextStepStatus(null, of('live'))).toMatchObject({ type: 'live' });
    });

    it('keeps what it has when nothing arrived', () => {
        expect(nextStepStatus(of('tool'), null)).toMatchObject({ type: 'tool' });
        expect(nextStepStatus(null, null)).toBeNull();
    });

    it('ranks every type it is given a name for', () => {
        expect(Object.keys(STATUS_PRIORITY)).toEqual(
            expect.arrayContaining(['live', 'thought', 'tool', 'confirm', 'error', 'final']));
    });
});

describe('statusClass', () => {
    it('names a class for the kinds that get one', () => {
        expect(statusClass('live')).toBe('live-status');
        expect(statusClass('error')).toBe('error-status');
    });

    it('leaves a thought and a final summary plain', () => {
        expect(statusClass('thought')).toBe('');
        expect(statusClass('final')).toBe('');
        expect(statusClass(undefined)).toBe('');
    });
});
