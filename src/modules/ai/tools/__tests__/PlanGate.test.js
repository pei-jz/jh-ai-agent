import { describe, it, expect } from 'vitest';
import { isMutatingTool, shouldBlock, planGateMessage, MUTATING_TOOLS } from '../PlanGate.js';

describe('isMutatingTool', () => {
    it('flags state-changing tools', () => {
        for (const t of ['write_file', 'multi_replace_file_content', 'replace_lines', 'run_command', 'delete_file', 'move_file', 'create_dir']) {
            expect(isMutatingTool(t)).toBe(true);
        }
    });
    it('does not flag read/investigation tools', () => {
        for (const t of ['read_file', 'grep_search', 'glob', 'list_files', 'propose_plan', 'finish_task', 'task_progress', 'verify_syntax']) {
            expect(isMutatingTool(t)).toBe(false);
        }
    });
    it('exposes the set', () => {
        expect(MUTATING_TOOLS.has('write_file')).toBe(true);
    });
});

describe('shouldBlock', () => {
    it('blocks mutating tools only when plan required and not yet approved', () => {
        expect(shouldBlock('write_file', true, false)).toBe(true);
        expect(shouldBlock('write_file', true, true)).toBe(false);   // approved
        expect(shouldBlock('write_file', false, false)).toBe(false); // not required
        expect(shouldBlock('read_file', true, false)).toBe(false);   // investigation
    });
});

describe('planGateMessage', () => {
    it('names the blocked tool and points to propose_plan', () => {
        const m = planGateMessage('run_command');
        expect(m).toContain('run_command');
        expect(m).toContain('propose_plan');
    });
});
