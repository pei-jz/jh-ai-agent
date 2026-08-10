import { describe, it, expect } from 'vitest';
import {
    composePersona, buildInstructionsBlock, hashText,
    instructionsTemplate, instructionsPathFor, REPLACE_MARKER,
} from '../ProjectInstructions.js';

describe('instructionsPathFor', () => {
    it('exposes the .agent DIRECTORY, not just the file — creating it is a guarded write', () => {
        expect(instructionsPathFor('C:/work/proj')).toEqual({
            root: 'C:/work/proj',
            dir: 'C:/work/proj/.agent',
            file: 'C:/work/proj/.agent/instructions.md',
        });
    });

    it('normalizes Windows separators throughout', () => {
        // The reported error dialog showed "C:\ws\.agent/instructions.md".
        const loc = instructionsPathFor('C:\\cusor_workspace\\Task');
        expect(loc.file).toBe('C:/cusor_workspace/Task/.agent/instructions.md');
        expect(loc.file).not.toContain('\\');
    });

    it('tolerates a trailing separator', () => {
        expect(instructionsPathFor('/home/u/proj/').file).toBe('/home/u/proj/.agent/instructions.md');
        expect(instructionsPathFor('C:\\ws\\\\').dir).toBe('C:/ws/.agent');
    });

    it('returns null for a blank workspace rather than a path rooted at "/"', () => {
        expect(instructionsPathFor('')).toBe(null);
        expect(instructionsPathFor('   ')).toBe(null);
        expect(instructionsPathFor('/')).toBe(null);
        expect(instructionsPathFor(null)).toBe(null);
        expect(instructionsPathFor(undefined)).toBe(null);
    });

    it('always yields a non-empty last segment for the template name', () => {
        expect(instructionsPathFor('C:/work/proj').root.split('/').pop()).toBe('proj');
        expect(instructionsPathFor('C:\\ws\\Task\\').root.split('/').pop()).toBe('Task');
    });
});

describe('composePersona', () => {
    const BASE = 'BUILT-IN PERSONA with safety rules';

    it('returns the base persona when the workspace has no file', () => {
        expect(composePersona(BASE, '')).toEqual({ text: BASE, mode: 'base' });
        expect(composePersona(BASE, null).mode).toBe('base');
        expect(composePersona(BASE, '   ').mode).toBe('base');
    });

    it('APPENDS by default so the built-in safety rules survive', () => {
        const { text, mode } = composePersona(BASE, 'Always answer in Japanese.');
        expect(mode).toBe('append');
        expect(text).toContain(BASE);                       // base kept
        expect(text).toContain('Always answer in Japanese.'); // override applied
        expect(text).toContain('<workspace_persona>');
    });

    it('replaces wholesale only with the explicit marker (legacy escape hatch)', () => {
        const { text, mode } = composePersona(BASE, `${REPLACE_MARKER}\nI am the only persona.`);
        expect(mode).toBe('replace');
        expect(text).toBe('I am the only persona.');
        expect(text).not.toContain(BASE);
    });

    it('a marker with an empty body does not wipe the persona', () => {
        expect(composePersona(BASE, REPLACE_MARKER)).toEqual({ text: BASE, mode: 'base' });
    });

    it('tolerates a missing base persona', () => {
        expect(composePersona('', 'only override').text).toContain('only override');
    });
});

describe('buildInstructionsBlock', () => {
    it('returns nothing when there are no instructions', () => {
        expect(buildInstructionsBlock('')).toEqual({ block: '', truncated: false, chars: 0 });
        expect(buildInstructionsBlock(null).block).toBe('');
        expect(buildInstructionsBlock('   ').block).toBe('');
    });

    it('wraps the text in a high-authority block naming its source', () => {
        const { block, truncated, chars } = buildInstructionsBlock('Run npm test after edits.');
        expect(block).toContain('<project_instructions');
        expect(block).toContain('authority="project"');
        expect(block).toContain('.agent/instructions.md');
        expect(block).toContain('Run npm test after edits.');
        expect(block).toContain('</project_instructions>');
        expect(truncated).toBe(false);
        expect(chars).toBe('Run npm test after edits.'.length);
    });

    it('passes normal-sized instructions through completely (no silent trimming)', () => {
        const text = Array.from({ length: 200 }, (_, i) => `- rule ${i}`).join('\n');
        const { block, truncated } = buildInstructionsBlock(text, { maxChars: 100000 });
        expect(truncated).toBe(false);
        expect(block).toContain('- rule 0');
        expect(block).toContain('- rule 199');   // the END survives too
    });

    it('keeps the HEAD and says so when oversized (never a silent middle cut)', () => {
        const text = 'A'.repeat(50) + 'B'.repeat(50);
        const { block, truncated, chars } = buildInstructionsBlock(text, { maxChars: 50 });
        expect(truncated).toBe(true);
        expect(chars).toBe(100);
        expect(block).toContain('A'.repeat(50));
        expect(block).not.toContain('B'.repeat(50));
        expect(block).toMatch(/省略されました/);      // omission is stated, not hidden
        expect(block).toContain('50 文字');           // and quantified
    });

    it('ignores a non-positive / non-finite maxChars (treated as unlimited)', () => {
        const text = 'x'.repeat(500);
        expect(buildInstructionsBlock(text, { maxChars: 0 }).truncated).toBe(false);
        expect(buildInstructionsBlock(text, { maxChars: NaN }).truncated).toBe(false);
    });
});

describe('hashText', () => {
    it('is stable for the same input', () => {
        expect(hashText('a', 'b')).toBe(hashText('a', 'b'));
    });
    it('changes when any part changes — the point is cache invalidation', () => {
        expect(hashText('rules v1')).not.toBe(hashText('rules v2'));
        expect(hashText('a', 'b')).not.toBe(hashText('a', 'c'));
    });
    it('is order-sensitive', () => {
        expect(hashText('a', 'b')).not.toBe(hashText('b', 'a'));
    });
    it('handles empty / nullish input', () => {
        expect(hashText()).toBe('0');
        expect(hashText('')).toBe('0');
        expect(typeof hashText(null, undefined)).toBe('string');
    });
    it('detects a one-character edit (no lazy length-only hashing)', () => {
        expect(hashText('run npm test')).not.toBe(hashText('run npm tests'));
        expect(hashText('abc')).not.toBe(hashText('abd'));
    });
});

describe('instructionsTemplate', () => {
    it('explains that the content is passed through verbatim', () => {
        const t = instructionsTemplate();
        expect(t).toContain('.agent/instructions.md');
        expect(t).toMatch(/省略されません|要約や省略/);
    });
    it('includes the project name when given', () => {
        expect(instructionsTemplate('jh-ai-agent')).toContain('jh-ai-agent');
    });
    it('is valid, non-empty markdown starting with a heading', () => {
        expect(instructionsTemplate().trimStart().startsWith('#')).toBe(true);
    });
});
