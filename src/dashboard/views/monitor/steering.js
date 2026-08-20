// steering — what happens when you type into the box under a task.
//
// Extracted from the 230-line steering block inside MonitorView._bindDetailEvents,
// where the decision (is this a mid-run nudge or a continuation of a finished
// task?) was buried between an attachment reader, a drag-drop registration, a
// preview renderer and two branches of DOM writes.
//
// The distinction matters and is not cosmetic:
//
//   • STEER goes down the open socket. The run is live and picks the message up
//     on its next step.
//   • CONTINUE is an HTTP call that starts a NEW run, and it must stamp a replay
//     cutoff first: the reconnect replays the entire prior task, and without the
//     cutoff that replayed `complete` wipes the message just sent and switches
//     tabs. See monitor/liveEvents.js for the gate that consumes the stamp.
//
// A task that STOPPED or FAILED continues too — "just keep going" is exactly
// what you want after a stall.

/** The block appended to the message for each non-image attachment. */
export function attachmentBlocks(files) {
    if (!files?.length) return '';
    return '\n\n' + files
        .map(f => `[Attached File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\`\n`)
        .join('\n');
}

/** Is there anything to send? */
export function hasSomethingToSend({ text, attachments = [], activeSkills = [] }) {
    return !!String(text || '').trim() || attachments.length > 0 || activeSkills.length > 0;
}

/**
 * Which of the two paths this message takes.
 *
 * @param {object} state
 * @param {boolean} state.taskFinished  the run ended (cleanly, stopped or failed)
 * @param {boolean} state.socketOpen    a live socket is available
 * @returns {'continue'|'steer'|'none'}
 */
export function steerMode({ taskFinished, socketOpen }) {
    if (taskFinished) return 'continue';
    return socketOpen ? 'steer' : 'none';
}

/**
 * The message to send, and what to show for it.
 *
 * `display` is what the user typed — the skill bodies and attached file contents
 * that `body` carries would drown the bubble.
 */
export function buildSteerMessage({ text, expandedPrompt, attachments = [] }) {
    const files = attachments.filter(a => a.type !== 'image');
    const images = attachments.filter(a => a.type === 'image').map(a => a.dataUrl);
    const base = expandedPrompt ?? String(text || '');
    return {
        body: base + attachmentBlocks(files),
        display: String(text || '') || base,
        images,
    };
}

/** The wire payload; `images` is omitted rather than sent empty. */
export function steerPayload({ body, images = [] }) {
    const payload = { message: body };
    if (images.length > 0) payload.images = images;
    return payload;
}

/** The frame a live steering message goes down the socket in. */
export function steerFrame(payload) {
    return JSON.stringify({ event: 'steering', data: payload });
}
