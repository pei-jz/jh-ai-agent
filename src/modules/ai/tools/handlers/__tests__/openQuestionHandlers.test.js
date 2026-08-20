import { describe, it, expect, beforeEach } from 'vitest';
import { handleOpenQuestion } from '../openQuestionHandlers.js';
import { OpenQuestions } from '../../../agent/OpenQuestions.js';

// The tool half of the investigation frontier. What matters here is that every
// mistake comes back as a usable instruction rather than a silent no-op: the
// model only learns the protocol from these strings.

describe('open_question', () => {
    let ctx;
    const call = (args) => handleOpenQuestion(ctx, args, () => {});

    beforeEach(() => {
        ctx = { openQuestions: new OpenQuestions() };
    });

    it('records a question and tells the model how to close it', async () => {
        const out = await call({ action: 'add', question: 'where is featureFlag set?' });
        expect(out).toContain('q1');
        expect(out).toMatch(/resolve/);
        expect(ctx.openQuestions.unresolved()).toHaveLength(1);
    });

    it('warns that dropping one silently will be caught', async () => {
        // The whole mechanism rests on the model believing this, so the promise
        // has to be made at the point the question is recorded — and the finish
        // gate has to keep it (see InvestigationGate.frontierCheck).
        const out = await call({ action: 'add', question: 'q?' });
        expect(out).toMatch(/silently|flagged/i);
    });

    it('closes a question and reports what is left', async () => {
        await call({ action: 'add', question: 'a?' });
        await call({ action: 'add', question: 'b?' });
        const out = await call({ action: 'resolve', id: 'q1', answer: 'set in WEB-INF/web.xml:31' });
        expect(out).toContain('q1 resolved');
        expect(out).toContain('Still open');
        expect(out).toContain('b?');
    });

    it('says so when the frontier is finally empty', async () => {
        await call({ action: 'add', question: 'a?' });
        const out = await call({ action: 'resolve', id: 'q1', answer: 'found in a.js:1' });
        expect(out).toMatch(/No open questions remain/);
    });

    it('refuses a resolve with no answer, and says why', async () => {
        await call({ action: 'add', question: 'a?' });
        const out = await call({ action: 'resolve', id: 'q1' });
        expect(out).toMatch(/^Error:/);
        expect(out).toMatch(/requires an `answer`/);
        expect(ctx.openQuestions.unresolved()).toHaveLength(1);
    });

    it('reports an unknown id instead of pretending to succeed', async () => {
        const out = await call({ action: 'resolve', id: 'q7', answer: 'x' });
        expect(out).toMatch(/^Error:/);
        expect(out).toContain('q7');
    });

    it('rejects an add with no question', async () => {
        const out = await call({ action: 'add' });
        expect(out).toMatch(/^Error:/);
        expect(out).toMatch(/requires `question`/);
    });

    it('does not double-record the same question', async () => {
        await call({ action: 'add', question: 'Where is the flag set?' });
        const out = await call({ action: 'add', question: 'where is THE FLAG set?' });
        expect(out).toMatch(/Already recorded as q1/);
        expect(ctx.openQuestions.size).toBe(1);
    });

    it('lists the frontier, and defaults to listing', async () => {
        expect(await call({ action: 'list' })).toMatch(/none/i);
        await call({ action: 'add', question: 'a?', why: 'display depends on it' });
        const out = await call({});
        expect(out).toContain('a?');
        expect(out).toContain('display depends on it');
    });

    it('names the valid actions when given a bad one', async () => {
        const out = await call({ action: 'destroy' });
        expect(out).toMatch(/unknown action/i);
        expect(out).toContain('add');
        expect(out).toContain('resolve');
    });

    it('fails clearly where no store exists rather than throwing', async () => {
        // Simple chat has no investigation frontier; the tool must not crash the
        // run if it is somehow reachable there.
        const out = await handleOpenQuestion({}, { action: 'add', question: 'x' }, () => {});
        expect(out).toMatch(/not available/);
    });
});
