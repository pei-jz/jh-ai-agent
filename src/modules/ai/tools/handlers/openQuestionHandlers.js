// open_question — the investigation frontier, as a tool.
//
// See agent/OpenQuestions.js for why a frontier is the thing that separates a
// shallow trace from a complete one: an investigation that only ever answers its
// FIRST question stops at whatever layer that question was asked about. This is
// how a run carries "I do not yet know where this value comes from" forward
// instead of dropping it, and how the finish gate can tell that it did.
//
// The store lives on the executor (one per run) so it survives across steps and
// is visible to AgentController's finish gate.

import { renderQuestions } from '../../agent/OpenQuestions.js';

export async function handleOpenQuestion(ctx, args, onAgentStatus) {
    const store = ctx.openQuestions;
    if (!store) return 'Error: open_question is not available in this context.';

    const action = String(args?.action || '').trim().toLowerCase() || 'list';

    if (action === 'list') {
        return renderQuestions(store.snapshot());
    }

    if (action === 'add') {
        const question = String(args?.question || '').trim();
        if (!question) {
            return 'Error: open_question action:"add" requires `question` — what do you not yet know?';
        }
        const { id, duplicate, capped } = store.add(question, args?.why);
        if (capped) {
            return 'Error: too many open questions already recorded. Resolve some before adding more — '
                + 'a frontier this long is a sign the scope needs narrowing, not extending.';
        }
        if (duplicate) {
            return `Already recorded as ${id} (not added twice).\n${renderQuestions(store.unresolved())}`;
        }
        onAgentStatus?.({ event: 'status', status: 'running', message: `❓ 未解決の論点を記録: ${question}` });
        return `Recorded as ${id}. Resolve it with open_question action:"resolve", or — if it turns out not to matter — `
            + `say so explicitly in your final answer. Finishing with it silently dropped will be flagged.\n`
            + renderQuestions(store.unresolved());
    }

    if (action === 'resolve') {
        const id = String(args?.id || '').trim();
        if (!id) return 'Error: open_question action:"resolve" requires `id`.';
        const { ok, error } = store.resolve(id, args?.answer);
        if (!ok) return `Error: ${error}`;
        onAgentStatus?.({ event: 'status', status: 'running', message: `✅ 論点を解決: ${id}` });
        const left = store.unresolved();
        return `${id} resolved.\n` + (left.length
            ? renderQuestions(left, { heading: 'Still open' })
            : 'No open questions remain.');
    }

    return `Error: unknown action "${action}". Use "add", "resolve" or "list".`;
}
