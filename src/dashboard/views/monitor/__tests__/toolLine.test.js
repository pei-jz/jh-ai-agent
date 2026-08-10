// The path a tool acted on has to survive as a FIELD, not be baked into prose —
// that is what lets a step offer the file as something you can open.

import { describe, it, expect } from 'vitest';
import { toolTarget, toolLineText } from '../toolLine.js';

describe('toolTarget', () => {
    it('extracts the file a read/write tool acted on', () => {
        expect(toolTarget('read_file', { path: 'src/app.js' }))
            .toEqual({ tool: 'read_file', path: 'src/app.js', label: 'app.js', write: false });
    });

    it('marks writing tools so a step can show a change, not a read', () => {
        for (const t of ['write_file', 'replace_lines', 'multi_replace_file_content', 'delete_file', 'write_xlsx']) {
            expect(toolTarget(t, { path: 'a.txt' }).write, t).toBe(true);
        }
        for (const t of ['read_file', 'verify_syntax', 'read_office']) {
            expect(toolTarget(t, { path: 'a.txt' }).write, t).toBe(false);
        }
    });

    it('follows move_file to its DESTINATION', () => {
        expect(toolTarget('move_file', { from: 'old/a.js', to: 'new/b.js' }).path).toBe('new/b.js');
        expect(toolTarget('move_file', { from: 'old/a.js' }).path).toBe('old/a.js');
    });

    it('gives a command or a query a label but NO path — there is no file to open', () => {
        expect(toolTarget('run_command', { command: 'npm  run   build' }))
            .toMatchObject({ path: '', label: 'npm run build' });
        expect(toolTarget('grep_search', { query: 'MonitorView' })).toMatchObject({ path: '', label: 'MonitorView' });
        expect(toolTarget('glob', { pattern: '**/*.js' })).toMatchObject({ path: '', label: '**/*.js' });
        expect(toolTarget('read_resource', { uri: 'jheditor::doc://current' })).toMatchObject({ path: '', label: 'jheditor::doc://current' });
    });

    it('clamps long commands and queries', () => {
        expect(toolTarget('run_command', { command: 'x'.repeat(200) }).label).toHaveLength(60);
        expect(toolTarget('grep_search', { query: 'y'.repeat(200) }).label).toHaveLength(40);
    });

    it('handles Windows separators when taking the basename', () => {
        expect(toolTarget('read_file', { path: 'C:\\work\\proj\\a.js' }).label).toBe('a.js');
        expect(toolTarget('read_file', { path: 'dir/sub/' }).label).toBe('sub');
    });

    it('returns something sane for an unknown tool or missing args', () => {
        expect(toolTarget('mystery_tool', { x: 1 })).toEqual({ tool: 'mystery_tool', path: '', label: '', write: false });
        expect(toolTarget()).toMatchObject({ tool: 'tool', path: '', label: '' });
        expect(toolTarget('read_file')).toMatchObject({ path: '', label: '' });
    });
});

describe('toolLineText', () => {
    it('reads as "✓ tool: target" when finished', () => {
        expect(toolLineText('read_file', { path: 'src/a.js' })).toBe('✓ read_file: a.js');
    });

    it('switches the mark while a tool is still running', () => {
        expect(toolLineText('run_command', { command: 'npm test' }, { done: false })).toBe('⚙ run_command: npm test');
    });

    it('keeps a sub-agent prefix so a child\'s work stays attributable', () => {
        expect(toolLineText('run_command', { command: 'cargo build' }, { prefix: '🤖 [sub:reviewer#1]' }))
            .toBe('🤖 [sub:reviewer#1] ✓ run_command: cargo build');
    });

    it('omits the colon when there is no target to name', () => {
        expect(toolLineText('finish_task', {})).toBe('✓ finish_task');
    });
});
