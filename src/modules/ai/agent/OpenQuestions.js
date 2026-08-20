// OpenQuestions — the frontier of an investigation.
//
// Why this exists. A run that only READS has no gate on it: the review gate
// fires on changed files, so an investigation passes straight through, and the
// only completion check asks whether text was produced — not whether the text is
// supported. The observed failure was an agent that explained a screen's
// behaviour entirely from the frontend, never tracing the backend configuration
// that actually determined it, and finished in a fraction of the time a thorough
// pass would take. Nothing was wrong with the answer it gave; the problem was
// that nothing asked whether the answer was the whole causal chain.
//
// A search that only ever answers its FIRST question cannot find that chain. The
// step that matters is the one where reading a file raises a NEW question ("this
// branches on a flag — where is the flag set?"), and the run has to be able to
// carry that question forward instead of dropping it. This is that carrier: the
// agent records determinants it has not traced yet, and the finish gate can see
// what is still open.
//
// No I/O — one instance per run, held by ToolExecutor.

/** Cap: a frontier longer than this is noise, not a plan. */
export const MAX_QUESTIONS = 40;

/** Normalise for dedupe — the same question asked twice is one question. */
function key(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export class OpenQuestions {
    constructor() {
        /** @type {{id: string, question: string, why: string, status: 'open'|'resolved', answer: string}[]} */
        this.items = [];
        this._seq = 0;
    }

    /**
     * Record something the answer depends on but that has not been traced.
     * Re-adding an existing question returns the original id rather than
     * duplicating it, so a loop that re-reads the same file does not inflate
     * the frontier.
     * @returns {{id: string, duplicate: boolean, capped: boolean}}
     */
    add(question, why = '') {
        const q = String(question || '').trim();
        if (!q) return { id: '', duplicate: false, capped: false };
        const existing = this.items.find(i => key(i.question) === key(q));
        if (existing) return { id: existing.id, duplicate: true, capped: false };
        if (this.items.length >= MAX_QUESTIONS) {
            return { id: '', duplicate: false, capped: true };
        }
        const id = `q${++this._seq}`;
        this.items.push({ id, question: q, why: String(why || '').trim(), status: 'open', answer: '' });
        return { id, duplicate: false, capped: false };
    }

    /**
     * Close a question with what was found. An answer is REQUIRED: "resolved"
     * with nothing to show for it is how a frontier gets cleared without being
     * investigated, which would make this whole mechanism worse than useless.
     * @returns {{ok: boolean, error?: string}}
     */
    resolve(id, answer) {
        const item = this.items.find(i => i.id === String(id || '').trim());
        if (!item) return { ok: false, error: `no open question with id "${id}"` };
        const a = String(answer || '').trim();
        if (!a) return { ok: false, error: 'resolving a question requires an `answer` — what did you find, and where?' };
        item.status = 'resolved';
        item.answer = a;
        return { ok: true };
    }

    /** Questions still open, in the order they were raised. */
    unresolved() {
        return this.items.filter(i => i.status === 'open');
    }

    get size() { return this.items.length; }

    /** Plain snapshot, for logs and the finish gate. */
    snapshot() {
        return this.items.map(i => ({ ...i }));
    }
}

/**
 * Render a list of questions for the model to read back.
 * Used by the `open_question` tool result and by the finish-gate message.
 */
export function renderQuestions(items, { heading = 'Open questions' } = {}) {
    const rows = Array.isArray(items) ? items : [];
    if (rows.length === 0) return `${heading}: none.`;
    const lines = rows.map((i) => {
        const why = i.why ? ` — ${i.why}` : '';
        const ans = i.status === 'resolved' && i.answer ? `\n    → ${i.answer}` : '';
        const mark = i.status === 'resolved' ? '[resolved]' : '[open]';
        return `- ${i.id} ${mark} ${i.question}${why}${ans}`;
    });
    return `${heading} (${rows.length}):\n${lines.join('\n')}`;
}
