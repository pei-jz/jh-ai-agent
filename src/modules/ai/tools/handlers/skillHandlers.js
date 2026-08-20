// skillHandlers — loading a written procedure on demand.
//
// The agent is given a CATALOGUE in its system prompt: one line per skill, name
// and description only. That is the whole point of `read_skill` — a ten-page
// procedure costs one line of context until the agent decides it applies.
//
// What this replaces: the agent used to read `.agent/skills.json`, a separate
// store the Skills tab could not edit and `/…` could not see, holding only
// name/description pairs with no bodies to load. A skill the user wrote was
// therefore invisible to a running agent; the only way in was to attach it to
// the first message, which pasted the entire body whether it was needed or not.

import { skillManager } from '../../SkillManager.js';

/**
 * read_skill — load one skill's instructions.
 *
 * Bundled files come back as absolute paths, so a skill that ships a script can
 * say "run scripts/sort.py" and the agent knows where that is. Running it still
 * goes through `run_command`, which is confirmed like any other shell call —
 * this tool reads, it never executes.
 */
export async function handleReadSkill(ctx, args, onAgentStatus) {
    const name = String(args?.name || '').trim();
    if (!name) {
        return "Error: read_skill requires a 'name' (the skill names are listed in your instructions).";
    }

    onAgentStatus?.(`Loading skill: /${name}...`);
    try {
        // Metadata may not have been loaded yet in this process; without it the
        // bundled-file list would come back empty and the skill would look like
        // prose with no scripts.
        if (!skillManager.getAll().length) await skillManager.refresh();

        const { text, meta, files } = await skillManager.load(name);
        ctx.onToolEvent?.('read_skill', { name, files: files.length });

        // A header that renames the skill is worth saying out loud: the filename
        // is what /… types and what this tool looks up, so the two disagree.
        const warn = meta.nameMismatch
            ? `\n\n(Note: this skill's header calls it "${meta.nameMismatch}", but it is invoked as "${name}".)`
            : '';
        return text + warn;
    } catch (e) {
        const known = skillManager.getAll().map(s => s.name);
        const hint = known.length ? ` Available: ${known.join(', ')}.` : ' No skills are installed.';
        return `Error: could not load skill '${name}' — ${e?.message || e}.${hint}`;
    }
}

/**
 * read_skill_file — one file bundled beside a skill.
 *
 * Reaching these through `read_file` would mean handing the agent a path outside
 * the workspace; this keeps the skills directory addressable by NAME, and the
 * Rust side refuses a `rel` that resolves outside the skill's own folder.
 */
export async function handleReadSkillFile(ctx, args, onAgentStatus) {
    const name = String(args?.name || '').trim();
    const rel = String(args?.path || '').trim();
    if (!name || !rel) {
        return "Error: read_skill_file requires 'name' (the skill) and 'path' (e.g. 'scripts/sort.py').";
    }

    onAgentStatus?.(`Reading /${name} → ${rel}...`);
    try {
        const text = await skillManager.readResource(name, rel);
        ctx.onToolEvent?.('read_skill_file', { name, path: rel });
        return `# /${name} → ${rel}\n${text}`;
    } catch (e) {
        return `Error: could not read '${rel}' from skill '${name}' — ${e?.message || e}`;
    }
}
