// ProjectOverview — the GIST layer: a few hundred tokens saying what this
// project is, kept in the prompt at all times.
//
// The layer this file adds, and why the other two are not enough:
//
//   overview  (here)   coarse, lossy, COMPLETE coverage   — always injected
//   index     (study)  symbol-precise, no coverage gaps   — queried, never injected
//   cards     (memory) verified experience                — recalled on a trigger
//
// A person does not hold 1,333 symbols in their head. They hold "Tauri app,
// dashboard is vanilla JS plus Svelte islands, the agent loop is in
// AgentController, memory lives under modules/ai/memory" — and go looking when
// they need a detail. The vague version is what makes the precise version
// usable: without knowing WHERE the memory layer lives, a symbol query is a
// guess.
//
// The first study pass shipped only the middle row, which is how it produced 716
// rows of `setSel → NewFileModal.js:307` and no sense of the project at all.
//
// ── Why this one uses an LLM when nothing else does ────────────────────────
// Every other memory writer here records only what was observed, because
// inference is where memory goes wrong. But "what is this module FOR" cannot be
// derived from an AST — that is the one thing only a reader can say. So this is
// the deliberate exception, and it is bounded three ways: it summarises the
// STRUCTURE (never raw source), it is small, and it is written to a file the
// user can read and correct.

import { targetPath } from './StudyPass.js';

/** Overview is standing context: it is in every prompt, so it has a hard cap. */
export const OVERVIEW_MAX_CHARS = 1600;
/** Directories described individually before the rest are summarised as "other". */
export const AREA_LIMIT = 14;
/** Exported names quoted per area — enough to recognise it, not to inventory it. */
export const NAMES_PER_AREA = 6;

const rel = (path, root) => {
    const p = String(path || '').replace(/\\/g, '/');
    const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return (r && p.toLowerCase().startsWith(r.toLowerCase() + '/')) ? p.slice(r.length + 1) : p;
};

/**
 * Fold a study pass into the DIGEST the summariser reads.
 *
 * Deliberately not the source: a model asked to describe a project from 400
 * files either reads 400 files (unaffordable) or reads eight and generalises
 * from those (wrong). The structure — which areas exist, how big they are, what
 * each one exports — is small, complete, and is what a human skims first.
 *
 * @param {Array<{q:string, target:string}>} cards study locator cards
 * @param {{root?:string, depth?:number}} opts
 */
export function structureDigest(cards, { root = '', depth = 3 } = {}) {
    const areas = new Map();
    for (const c of (cards || [])) {
        const path = rel(targetPath(c?.target), root);
        if (!path) continue;
        const parts = path.split('/');
        const dir = parts.slice(0, Math.min(depth, Math.max(1, parts.length - 1))).join('/');
        const a = areas.get(dir) || { dir, files: new Set(), names: [] };
        a.files.add(path);
        if (c.q) a.names.push(c.q);
        areas.set(dir, a);
    }

    return [...areas.values()]
        .map(a => ({ dir: a.dir, files: a.files.size, names: a.names }))
        // Biggest first: the areas that dominate a tree are the ones a newcomer
        // needs named, and the tail is noise in a few hundred tokens.
        .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
}

/** Render the digest as the prompt the summariser is given. */
export function buildOverviewPrompt(areas, { projectName = '', extra = '' } = {}) {
    const shown = areas.slice(0, AREA_LIMIT);
    const rest = areas.slice(AREA_LIMIT);
    const lines = shown.map(a =>
        `- ${a.dir}/  (${a.files} files)  exports: ${a.names.slice(0, NAMES_PER_AREA).join(', ') || '—'}`);
    if (rest.length) {
        lines.push(`- …and ${rest.length} smaller areas (${rest.reduce((s, a) => s + a.files, 0)} files)`);
    }

    return `You are writing the orientation note a new engineer reads before touching this codebase.

Project: ${projectName || '(unnamed)'}
${extra ? `\nExtra context supplied by the user:\n${extra}\n` : ''}
Structure (directories by size, with the names they export):
${lines.join('\n')}

Write UNDER 900 characters, as plain markdown bullets, covering only:
1. What this project appears to BE (one sentence — the kind of application, its stack).
2. The 3-6 areas that matter, one line each: what that area is responsible for.
3. Any convention the structure itself reveals (e.g. tests live beside the code,
   a pure-logic/IO split, a UI layer with two technologies).

Rules:
- Describe only what the structure supports. Where it is ambiguous, say "appears to".
- Do NOT invent features, business purpose, or history you cannot see here.
- No preamble, no closing summary, no headings — bullets only.`;
}

/**
 * Clean the model's answer into something safe to put in every prompt.
 * Strips markdown fences and any preamble line, and enforces the cap.
 */
export function normalizeOverview(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
    // Models like to open with "Here is the orientation note:" — drop a lead-in
    // line that is not itself a bullet.
    const lines = s.split('\n');
    while (lines.length && !/^\s*[-*\d]/.test(lines[0]) && lines[0].trim().endsWith(':')) lines.shift();
    s = lines.join('\n').trim();
    return s.length > OVERVIEW_MAX_CHARS ? s.slice(0, OVERVIEW_MAX_CHARS - 1) + '…' : s;
}

/**
 * The standing block for the system prompt.
 *
 * Labelled as generated and fallible on purpose. It sits near the user's own
 * `.agent/instructions.md`, which is NORMATIVE; conflating the two would give a
 * machine's guess the same standing as the user's rules.
 */
export function renderOverview(text, { generatedAt = '' } = {}) {
    const body = String(text || '').trim();
    if (!body) return '';
    return `<project_overview generated="${generatedAt}">
<!-- Auto-generated orientation from the project's structure. Broad but shallow,
     and possibly out of date: prefer what you read in the files over this. -->
${body}
</project_overview>`;
}

/** Is the stored overview old enough to be worth regenerating? */
export function isOverviewStale(meta, { now = Date.now(), maxAgeDays = 30 } = {}) {
    const at = Date.parse(meta?.generatedAt || '') || 0;
    if (!at) return true;
    return (now - at) / 86_400_000 > maxAgeDays;
}
