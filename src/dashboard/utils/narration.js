// narration — extract the model's PROSE narration out of a live token stream.
//
// DISPLAY-ONLY. This never touches the agent's finalResponse / resultSummary /
// present_result envelope (those keep going through AgentController's own
// cleanFinalResponse), so it cannot affect the result report, the finish_task
// output, or the result feedback sent to JHEditor.
//
// The model is asked (native mode only) to say what it's about to do in 1–2
// plain sentences BEFORE emitting a tool call. So in the raw stream the shape is:
//
//     <prose narration><structural payload: ```json / <tool_call> / {…}>
//
// We therefore render only the prose PREFIX and stop at the first structural
// marker. Consequences that make this safe by construction:
//   • A JSON-mode model (whole reply is one JSON envelope) yields an EMPTY
//     prefix → nothing is shown, so raw JSON can never leak into the chat.
//   • A broken model emitting <function=…> XML also yields an empty/short
//     prefix → the XML never reaches the UI.
//   • Under-showing is always preferred to leaking machinery.

/** Literal markers that begin non-prose (tool call / JSON envelope / code). */
const MARKERS = [
    '```',            // code fence (incl. ```json)
    '<tool_call',     // XML-ish tool call (broken native models)
    '<tool_calls',
    '<function=',
    '<thought>',
    '"tool_calls"',
    '{"',             // inline JSON envelope
];

/**
 * Prose prefix of a (possibly partial) streamed response.
 * @param {string} raw - accumulated stream text for the current step
 * @returns {string} narration prose ('' when the reply is pure machinery)
 */
export function extractNarration(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';

    let cut = s.length;
    for (const m of MARKERS) {
        const i = s.indexOf(m);
        if (i !== -1 && i < cut) cut = i;
    }
    // A '{' opening a line also starts a JSON envelope (models often emit the
    // object on its own line after the prose).
    const brace = s.search(/(?:^|\n)\s*\{/);
    if (brace !== -1 && brace < cut) cut = brace;

    // Trailing partial marker (e.g. the stream is mid-way through "``" or "<")
    // would otherwise flicker as stray punctuation at the end of the bubble.
    return s.slice(0, cut).replace(/[`<{]+\s*$/, '').trim();
}
