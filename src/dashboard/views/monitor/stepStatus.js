// stepStatus — what a step's header should say, given the event that just landed.
//
// Extracted from the `else` branch of connectWebSocket's All-Logs block, where
// the decision was a 90-line if/else chain interleaved with DOM lookups: each
// arm re-ran `querySelectorAll('.mstep:not(#mstep-init)')`, took the last
// element, and read or wrote a `dataset` field on it. The rules and the lookups
// were impossible to tell apart, and two of the rules exist because of specific
// reported symptoms:
//
//   • a sub-agent's finished tool used to re-show the PARENT step's stored
//     thought, so the same sentence repeated after every child tool and flooded
//     the feed. A child's own action is shown instead.
//   • `tool_call` fires ONCE per tool, at start. Completion arrives separately as
//     a `log` with method='TOOL'. Reading `tool_call` as "done" showed a finished
//     label while the tool was still running.
//
// The step's remembered fields (`thoughtSummary`, `lastTool`) are passed in and
// returned rather than read off an element, so the caller owns where they live.

/**
 * @typedef {object} StepStatus
 * @property {string} text     what the header shows
 * @property {string} type     priority band: 'thought' | 'tool' | 'confirm' | 'error'
 * @property {string} [feed]   a different line for the activity feed, when they differ
 * @property {*}      [target] the thing acted on (file / command), for the inspector
 * @property {object} [remember] fields the step should carry forward
 */

/**
 * @param {object} packet
 * @param {object} step        what this step already remembers
 * @param {string} [step.thoughtSummary]
 * @param {string} [step.lastTool]
 * @param {object} deps
 * @param {Function} deps.summarizeThought  (raw) => string
 * @param {Function} deps.toolActionLabel   (data) => string
 * @param {Function} deps.toolTarget        (name, args) => any
 * @returns {StepStatus|null} null when the event says nothing about the step
 */
export function stepStatusFor(packet, step = {}, deps = {}) {
    const {
        summarizeThought = (t) => String(t ?? ''),
        toolActionLabel = (d) => `✓ ${d?.name || 'tool'} done`,
        toolTarget = () => null,
    } = deps;

    const event = packet?.event;
    const data = packet?.data || {};

    if (event === 'thought') {
        const raw = typeof data.text === 'string' ? data.text : JSON.stringify(data.text);
        const text = summarizeThought(raw);
        // Remembered so that when a tool later completes, the header can go back
        // to what the step ACHIEVED rather than sitting on "✓ tool done".
        return { text, type: 'thought', remember: { thoughtSummary: text } };
    }

    if (event === 'tool_call') {
        const name = data.name || 'tool';
        const hint = toolActionLabel({ name, request: data.args }).replace(/^✓\s*/, '');
        return {
            text: `⚙ Running: ${hint}…`,
            type: 'tool',
            target: toolTarget(name, data.args),
            remember: { lastTool: name },
        };
    }

    if (event === 'confirm_request') {
        return { text: '⏸ Awaiting approval…', type: 'confirm' };
    }

    if (event === 'error') {
        return { text: '⚠ Error — recovering', type: 'error' };
    }

    if (event === 'log' && data.method === 'TOOL') {
        const label = String(data.stepLabel || '');
        const isSubAgent = label.includes('🤖') || label.includes('sub:');
        if (isSubAgent) {
            // The forwarded "🤖 [sub:…] ⚙ tool: arg" line already says what the
            // child is doing; echoing the parent's thought here repeated the same
            // sentence after every child tool.
            return {
                text: toolActionLabel(data),
                type: 'tool',
                target: toolTarget(data.name, data.request),
            };
        }
        const name = data.name || step.lastTool || 'tool';
        // Header → this step's thought (its story). Feed → this tool's own
        // action; putting the thought in both duplicated it directly under its
        // own "⚙ Running: X…" line.
        return {
            text: step.thoughtSummary || `✓ ${name} done`,
            type: 'tool',
            feed: toolActionLabel(data),
        };
    }

    if (event === 'status' && data.message) {
        const msg = String(data.message);
        if (/retry|recover/i.test(msg)) return { text: `↻ ${msg.slice(0, 60)}`, type: 'error' };
        // Sub-agent activity and review-gate progress. Without these the feed goes
        // SILENT while children work — the parent emits no thought or tool events
        // of its own — and the "…" thinking placeholder lingers over nothing.
        if (msg.startsWith('🤖') || msg.startsWith('🔎')) return { text: msg, type: 'tool' };
        return null;
    }

    return null;
}

/**
 * How strongly a label claims the step header.
 *
 * A step emits several things at once — a thought, a tool starting, an approval
 * pausing it — and the header has room for one. Higher wins, and `final` cannot
 * be overwritten at all: once a step has been summarised, a late live event must
 * not put "Calling LLM…" back on a finished step.
 */
export const STATUS_PRIORITY = { live: 0, thought: 1, tool: 2, confirm: 3, error: 4, final: 99 };

/**
 * Which of the two labels the header should keep.
 *
 * @param {{text:string,type:string}|null} current
 * @param {{text:string,type:string}|null} incoming
 * @returns {{text:string,type:string}|null}
 */
export function nextStepStatus(current, incoming) {
    if (!incoming) return current;
    const now = STATUS_PRIORITY[current?.type] ?? -1;
    const next = STATUS_PRIORITY[incoming.type] ?? 0;
    if (now >= STATUS_PRIORITY.final) return current;
    return next < now ? current : incoming;
}

/** The CSS class a label of this kind carries; thought and final are plain. */
export function statusClass(type) {
    return { live: 'live-status', tool: 'tool-status', error: 'error-status', confirm: 'confirm-status' }[type] || '';
}
