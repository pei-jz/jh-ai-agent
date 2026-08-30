// askConversation — a run's timeline, read as a conversation.
//
// docs/design/information-architecture.md §4 said an `ask` run must not look
// like a task, and the first implementation got that half right: it FILTERED the
// timeline (askView.js) but still handed the survivors to the timeline renderer,
// so an answer arrived wearing step-line chrome. What was asked for is the old
// Chat surface — bubbles, and tool work behind a closed disclosure — and that
// surface still exists as a pair of components. It just needed feeding.
//
// So this is a MAPPER, not a second renderer: timeline items in, the message
// shape svelte/work/AskMessage.svelte already understands out. The run itself is
// unchanged (one engine, logged, billed, remembered); only its presentation
// differs, which is the whole point of the interaction axis.
//
// Pure — the view passes items in and mounts what comes out.

/** Tool activity lines carry `tool`; other activity is the agent's reasoning. */
const isToolLine = (i) => !!(i && i.kind === 'activity' && i.tool);

/** A group item holds its lines in `.lines` rather than on itself. */
const linesOf = (i) => (Array.isArray(i?.lines) ? i.lines : [i]);

/**
 * The text a bubble shows for an item, or '' when it has nothing to say.
 * `answer` is the ask_user shape; `text` is everything else.
 */
const textOf = (i) => String(i?.text ?? i?.answer ?? '').trim();

/**
 * Turn a run's timeline into chat messages.
 *
 * The grouping rule is the one the old Chat had, and it is what keeps a
 * conversation readable: CONSECUTIVE tool work collapses into ONE call bubble
 * plus ONE result bubble, both closed. Three lookups in a row are one line that
 * says "3", not three lines to scroll past on the way to the answer.
 *
 * @param {Array} items the same items the build view renders
 * @returns {Array} messages for AskConversation / AskMessage
 */
export function askMessages(items) {
    const src = Array.isArray(items) ? items : [];
    const out = [];
    /** The open tool run, flushed when prose or the end interrupts it. */
    let pending = [];

    const flush = () => {
        if (!pending.length) return;
        out.push({
            isToolCall: true,
            toolCalls: pending.map(l => ({ name: l.tool, args: l.args || { target: l.path || l.text || '' } })),
        });
        out.push({
            isToolResult: true,
            results: pending.map(l => ({
                tool_call_name: l.tool,
                result: l.result != null ? l.result : String(l.text || ''),
            })),
        });
        pending = [];
    };

    for (const item of src) {
        if (!item) continue;

        // Groups hold their tool lines inside; unwrap before classifying.
        if (item.kind === 'group') {
            for (const line of linesOf(item)) {
                if (line?.tool) pending.push(line);
            }
            continue;
        }

        if (isToolLine(item)) { pending.push(item); continue; }

        switch (item.kind) {
            case 'request':
                flush();
                if (textOf(item)) out.push({ role: 'user', content: textOf(item) });
                break;

            // The answer.
            //
            // `document` FIRST, because it is the one that actually arrives:
            // splitForPanes REPLACES the deliverable with a derived `document`
            // item in place, so by the time the view has items to render there
            // is no `deliverable` left. Mapping only the latter is why an `ask`
            // run showed its tool line and then nothing — the answer was
            // present, correctly, under the other name.
            //
            // `run` carries the answer when the turn ended without
            // present_result; `narration` is the streamed prose before it. All
            // four are the assistant talking.
            case 'document':
            case 'deliverable':
            case 'run':
            case 'narration':
                flush();
                if (textOf(item)) out.push({ role: 'assistant', content: textOf(item) });
                break;

            case 'ask':
                flush();
                if (textOf(item)) out.push({ role: 'assistant', content: textOf(item) });
                break;

            case 'error':
                flush();
                out.push({ role: 'assistant', isError: true, content: textOf(item) || 'Error' });
                break;

            // Steps, turns, folds, task_progress, run markers: machinery. An
            // `ask` run should not produce most of them, and none of them is
            // something a person asked to see.
            default:
                break;
        }
    }
    flush();
    return out;
}

/**
 * Does this run have anything to show yet?
 *
 * Used to keep the empty state from flashing between "task created" and the
 * first item arriving — the old Chat had a real empty state because it started
 * empty; a run always has at least the request.
 */
export function hasConversation(messages) {
    return Array.isArray(messages) && messages.length > 0;
}
