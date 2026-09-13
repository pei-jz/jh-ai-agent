// ProjectContext is a process-wide singleton. Without a root check, the prompt
// for workspace B carried the structure of workspace A whenever A was the last
// one scanned.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
const { projectContext } = await import('../ProjectContext.js');

describe('ProjectContext.getPromptContext(root)', () => {
    it('returns nothing for a workspace other than the one scanned', () => {
        projectContext.projectSummary = 'SUMMARY-OF-A';
        projectContext.rootPath = 'C:/work/a';
        expect(projectContext.getPromptContext('C:/work/b')).toBe('');
    });

    it('matches regardless of separator, case and trailing slash', () => {
        projectContext.projectSummary = 'SUMMARY-OF-A';
        projectContext.rootPath = 'C:/work/a';
        expect(projectContext.getPromptContext('c:\\Work\\A\\')).toContain('SUMMARY-OF-A');
    });

    it('keeps the old behaviour when no root is passed', () => {
        projectContext.projectSummary = 'SUMMARY-OF-A';
        projectContext.rootPath = 'C:/work/a';
        expect(projectContext.getPromptContext()).toContain('SUMMARY-OF-A');
    });
});
