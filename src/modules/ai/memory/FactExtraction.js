// FactExtraction — PURE prompt + parsing for the end-of-session summary.
//
// Step 3 of docs/scratch/agent-memory-learning.plan.md. Extracted from
// ConversationMemory._generateStructuredSummary so the two things that decide
// what enters long-term memory — what the model is ASKED for, and how its answer
// is read — are testable without a provider.
//
// Two changes to what the model is asked for:
//
//   • Each fact now declares its KIND. "Always run npm test" (a norm) and
//     "ConfigView.js was edited" (a work log) used to arrive as identical
//     strings, so the store could not tell a rule from a diary entry.
//   • A USER CORRECTION outranks everything else. It is the highest-value
//     learning signal there is — the user telling the agent it was wrong — and
//     until now it lived only in the transcript and was lost at session end.

/** A fact's kind decides whether, and how fast, it reaches semantic memory. */
export const FACT_KINDS = ['norm', 'observation', 'worklog'];

/** The JSON the summariser must produce. */
export function buildSummaryPrompt(query, response) {
    return `Analyze the following interaction with the AI assistant and output a JSON object summarizing it.
Do not output any markdown code blocks or explanations, just the raw JSON object.

[User Query]
${String(query || '').substring(0, 500)}

[AI Final Response]
${String(response || '').substring(0, 1500)}

JSON output format:
{
  "topic": "Topic of interaction within 40 characters",
  "actions": ["Up to 3 short sentences of actions taken"],
  "outcome": "success or partial or error",
  "keyFiles": ["Up to 3 main file paths modified/referenced"],
  "category": "2-4 word area this task belongs to, e.g. \\"settings screen\\" or \\"billing schema\\"",
  "summary": "Summary of what was done and achieved within 120 characters",
  "facts": [
    {
      "text": "One durable fact worth remembering long-term",
      "kind": "norm | observation | worklog"
    }
  ]
}

Rules for "facts" (up to 3, empty array if none):
- FIRST, if the user CORRECTED the assistant — told it the right command, path,
  convention, or that its approach was wrong — record that correction as a fact
  with kind "norm". This outranks everything else; never omit it.
- "norm": a rule that holds beyond this task — a project convention, a required
  command, a decision, a constraint, something to always or never do.
- "observation": a durable fact about how the project IS — architecture, where
  something lives, a gotcha.
- "worklog": what happened this session ("edited X", "fixed the bug"). Label it
  honestly; these are discarded, so do not disguise one as a norm.`;
}

const str = (v, max) => String(v ?? '').substring(0, max);

/**
 * Normalize one entry of the model's `facts` array.
 * Accepts the object form and the legacy bare string (older models, and every
 * fact written before this change), so nothing has to be migrated.
 * @returns {{text: string, kind: string}|null}
 */
export function normalizeFactCandidate(raw) {
    if (typeof raw === 'string') {
        const text = raw.trim();
        // No kind declared ⇒ treat as an observation: it must earn promotion by
        // recurring, rather than being trusted as a rule on one sighting.
        return text ? { text: str(text, 300), kind: 'observation' } : null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text ?? raw.fact ?? '').trim();
    if (!text) return null;
    const kind = FACT_KINDS.includes(raw.kind) ? raw.kind : 'observation';
    return { text: str(text, 300), kind };
}

/**
 * Parse the summariser's JSON into the entry shape ConversationMemory stores.
 * Throws when there is no JSON object at all — the caller has a fallback for
 * that; silently returning an empty entry would hide a broken summariser.
 */
export function parseSummary(rawResult, { sessionId = null, now = Date.now() } = {}) {
    const match = String(rawResult || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('LLM did not return valid JSON');
    const parsed = JSON.parse(match[0]);

    return {
        timestamp: now,
        date: new Date(now).toISOString().split('T')[0],
        sessionId: sessionId || null,
        topic: str(parsed.topic, 80),
        actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3).map(a => str(a, 100)) : [],
        outcome: ['success', 'partial', 'error'].includes(parsed.outcome) ? parsed.outcome : 'unknown',
        keyFiles: Array.isArray(parsed.keyFiles) ? parsed.keyFiles.slice(0, 3).map(f => str(f, 150)) : [],
        category: str(parsed.category, 60),
        summary: str(parsed.summary, 200),
        facts: (Array.isArray(parsed.facts) ? parsed.facts : [])
            .slice(0, 3)
            .map(normalizeFactCandidate)
            .filter(Boolean),
    };
}
