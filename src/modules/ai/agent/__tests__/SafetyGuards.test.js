// Tests for agent/SafetyGuards.js — the pure safety/loop guards extracted
// from AgentController.js (P3 monolith split).

import { describe, it, expect } from 'vitest';
import {
    PLAN_GATED_TOOLS, MUTATING_TOOLS, classifyToolCalls, planFirstGate,
    isPlanGatedTool, evaluateWallClock, evaluateTokenBudget,
    evaluateIdenticalCalls, hasIdenticalTail, findCycle, isNoProgressWindow,
    iterationMadeProgress, phaseSignalForToolCalls,
    noProgressCheckMessage, identicalCallWarning, tailLoopWarning, cycleWarning,
} from '../SafetyGuards.js';

describe('classifyToolCalls', () => {
    it('splits calls by permission level', () => {
        const calls = [
            { name: 'read_file', args: {} },
            { name: 'write_file', args: {} },
            { name: 'delete_file', args: {} },
        ];
        const level = (name) => name === 'write_file' ? 'Ask' : (name === 'delete_file' ? 'Deny' : 'Allow');
        const { safeCalls, dangerousCalls, deniedCalls } = classifyToolCalls(calls, level);
        expect(safeCalls.map(c => c.name)).toEqual(['read_file']);
        expect(dangerousCalls.map(c => c.name)).toEqual(['write_file']);
        expect(deniedCalls.map(c => c.name)).toEqual(['delete_file']);
    });

    it('defaults to Allow when no permission function', () => {
        const { safeCalls, dangerousCalls, deniedCalls } = classifyToolCalls([{ name: 'a', args: {} }], null);
        expect(safeCalls).toHaveLength(1);
        expect(dangerousCalls).toHaveLength(0);
        expect(deniedCalls).toHaveLength(0);
    });
});

describe('planFirstGate', () => {
    it('activates for DirectChat with a complex prompt (auto)', () => {
        const gate = planFirstGate({ prompt: 'please implement a multi step feature in these files: a.js b.js c.js', caller: 'DirectChat', isFreshTurn: true });
        expect(gate.active).toBe(true);
        expect(gate.approved).toBe(false);
    });

    it('does not activate for Schedule or external callers', () => {
        expect(planFirstGate({ prompt: 'complex task', caller: 'Schedule', isFreshTurn: true }).active).toBe(false);
        expect(planFirstGate({ prompt: 'complex task', caller: 'External', isFreshTurn: true }).active).toBe(false);
        expect(planFirstGate({ prompt: 'complex task', caller: 'DirectChat', isSubagent: true, isFreshTurn: true }).active).toBe(false);
    });

    it('respects planMode off and bypass phrases', () => {
        expect(planFirstGate({ prompt: 'complex', caller: 'DirectChat', planMode: 'off', isFreshTurn: true }).active).toBe(false);
        expect(planFirstGate({ prompt: 'そのまま実装してください', caller: 'DirectChat', isFreshTurn: true }).active).toBe(false);
        expect(planFirstGate({ prompt: 'no plan needed', caller: 'DirectChat', isFreshTurn: true }).active).toBe(false);
    });

    it('always gates in always mode', () => {
        const gate = planFirstGate({ prompt: 'quick', caller: 'DirectChat', planMode: 'always', isFreshTurn: true });
        expect(gate.active).toBe(true);
    });

    it('re-opens on a plan-revision turn and extracts revision text', () => {
        const gate = planFirstGate({
            // The ✏️ marker line is stripped; the user's own words follow it.
            prompt: '✏️ Request changes\nmake it faster', caller: 'DirectChat',
            isFreshTurn: false, isPlanRevisionTurn: true,
        });
        expect(gate.active).toBe(true);
        expect(gate.revisionText).toBe('make it faster');
    });
});

describe('isPlanGatedTool', () => {
    it('gates mutating tools', () => {
        expect(isPlanGatedTool('write_file', {})).toBe(true);
        expect(isPlanGatedTool('delete_file', {})).toBe(true);
        expect(isPlanGatedTool('read_file', {})).toBe(false);
        expect(isPlanGatedTool('grep_search', {})).toBe(false);
    });

    it('lets safe shell commands pass during planning', () => {
        expect(isPlanGatedTool('run_command', { command: 'git status' })).toBe(false);
        expect(isPlanGatedTool('run_command', { command: 'npm test' })).toBe(true);
    });
});

describe('evaluateWallClock', () => {
    it('stops at 100% of budget', () => {
        const r = evaluateWallClock({ elapsedMs: 61 * 1000, budgetMinutes: 1 });
        expect(r.stop).toBe(true);
        expect(r.reason.kind).toBe('wall_clock');
    });

    it('warns once at 80%', () => {
        const r = evaluateWallClock({ elapsedMs: 49 * 1000, budgetMinutes: 1 });
        expect(r.stop).toBe(false);
        expect(r.warn).toBe(true);
        // already warned → no re-warn
        expect(evaluateWallClock({ elapsedMs: 50 * 1000, budgetMinutes: 1, pctWarned: true }).warn).toBe(false);
    });

    it('disabled at 0 budget', () => {
        expect(evaluateWallClock({ elapsedMs: 999999, budgetMinutes: 0 })).toEqual({ stop: false, warn: false, reason: null });
    });
});

describe('evaluateTokenBudget', () => {
    it('stops at 100% and warns at 80%', () => {
        expect(evaluateTokenBudget({ spent: 100, budgetTokens: 100 }).stop).toBe(true);
        const w = evaluateTokenBudget({ spent: 80, budgetTokens: 100 });
        expect(w.stop).toBe(false);
        expect(w.warn).toBe(true);
        expect(evaluateTokenBudget({ spent: 80, budgetTokens: 100, warned: true }).warn).toBe(false);
    });

    it('disabled at 0', () => {
        expect(evaluateTokenBudget({ spent: 100, budgetTokens: 0 }).stop).toBe(false);
    });
});

describe('evaluateIdenticalCalls', () => {
    it('warns at warnAt and stops at 3x warnAt', () => {
        let state = evaluateIdenticalCalls({ signature: 's', lastSignature: 's', repeatCount: 4, warnAt: 5 });
        expect(state.warn).toBe(true);
        state = evaluateIdenticalCalls({ signature: 's', lastSignature: 's', repeatCount: 14, warnAt: 5 });
        expect(state.stop).toBe(true);
    });

    it('resets on a different signature', () => {
        const state = evaluateIdenticalCalls({ signature: 'new', lastSignature: 'old', repeatCount: 10, warnAt: 5 });
        expect(state.isRepeat).toBe(false);
        expect(state.repeatCount).toBe(0);
    });
});

describe('hasIdenticalTail / findCycle', () => {
    it('detects a 5x identical tail', () => {
        const history = ['a', 'a', 'a', 'a', 'a'].map(n => ({ name: 'read_file', argsStr: n }));
        expect(hasIdenticalTail(history, 5)).toBe(true);
        expect(hasIdenticalTail([{ name: 'a', argsStr: '1' }, { name: 'b', argsStr: '2' }], 5)).toBe(false);
    });

    it('finds ABAB cycles via LoopDetector', () => {
        const history = ['a', 'b', 'a', 'b', 'a', 'b'].map(n => ({ name: n, argsStr: '1' }));
        const cycle = findCycle(history, 3);
        expect(cycle).not.toBeNull();
        expect(cycle.pattern).toContain('a');
    });

    it('returns null when disabled', () => {
        expect(findCycle([{ name: 'a', argsStr: '1' }], 0)).toBeNull();
    });
});

describe('no-progress helpers', () => {
    it('detects a no-progress window', () => {
        expect(isNoProgressWindow([false, false, false], 3)).toBe(true);
        expect(isNoProgressWindow([true, false, false], 3)).toBe(false);
        expect(isNoProgressWindow([false, false], 3)).toBe(false);
        expect(isNoProgressWindow([false, false, false], 0)).toBe(false);
    });

    it('iterationMadeProgress checks the mutating set', () => {
        expect(iterationMadeProgress(['read_file', 'write_file'])).toBe(true);
        expect(iterationMadeProgress(['read_file', 'grep_search'])).toBe(false);
        expect(iterationMadeProgress(null)).toBe(false);
    });

    it('phaseSignalForToolCalls maps mutation / plan-done / null', () => {
        expect(phaseSignalForToolCalls(['read_file', 'write_file'])).toBe('mutation');
        expect(phaseSignalForToolCalls(['task_progress'])).toBe('plan-done');
        expect(phaseSignalForToolCalls(['read_file'])).toBeNull();
    });

    it('produces the check-in and warning texts', () => {
        expect(noProgressCheckMessage(5)).toContain('5 consecutive steps');
        expect(identicalCallWarning('read_file', 3)).toContain('read_file');
        expect(tailLoopWarning('write_file')).toContain('write_file');
        expect(cycleWarning({ pattern: 'AB', repeats: 3 })).toContain('AB');
    });
});

describe('tool sets', () => {
    it('PLAN_GATED_TOOLS covers the mutating toolset', () => {
        expect(PLAN_GATED_TOOLS.has('write_file')).toBe(true);
        expect(PLAN_GATED_TOOLS.has('run_command')).toBe(true);
        expect(PLAN_GATED_TOOLS.has('read_file')).toBe(false);
    });

    it('MUTATING_TOOLS counts real progress', () => {
        expect(MUTATING_TOOLS.has('write_file')).toBe(true);
        expect(MUTATING_TOOLS.has('finish_task')).toBe(true);
        expect(MUTATING_TOOLS.has('read_file')).toBe(false);
    });
});
