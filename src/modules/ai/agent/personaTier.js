// personaTier — which kind of agent this task's prompt should describe.
//
// This replaces a two-way branch in ContextBuilder that read
// "does the allowlist contain any editing tool?" and produced either an
// "elite autonomous software engineer" or a one-paragraph "helpful AI assistant".
//
// That shape made code work a first-class citizen and everything else a fallback:
// a task that reads a workbook and writes a report got the SLIM prompt, because a
// slim prompt was originally an optimisation for tiny app-intent calls — not a
// description of a general-purpose agent. It also meant `.agent/agents/default.md`
// (the user's own persona file) was only consulted for editing tasks.
//
// Three tiers, decided by what the task can actually DO, because that is the part
// the prompt has to be honest about:
//
//   develop  — can edit files AND run commands. Code work: change it, then verify.
//   general  — can produce things (write a file, a workbook, a deliverable) but
//              cannot run commands. Reports, analysis, documents, data work.
//   scoped   — neither. A read-only lookup or a single app intent, where a long
//              persona is pure token cost.

/** Editing a file is what separates "can act on the project" from "can only look". */
const EDIT_TOOLS = new Set([
    'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'delete_file', 'move_file', 'create_dir',
]);

/**
 * Producing a deliverable, without touching source.
 *
 * `update_xlsx` belongs here even though it edits: what it edits is a ledger or a
 * form, not project source, and updating one is exactly the general-purpose work
 * this tier exists for.
 */
const PRODUCE_TOOLS = new Set([
    'write_xlsx', 'update_xlsx', 'write_docx',
    'present_result',
]);

/** The tiers, in descending capability. Exported so callers can name one. */
export const PERSONA_TIERS = ['develop', 'general', 'scoped'];

/**
 * Which tier a task belongs to.
 *
 * @param {string[]} toolNames the task's ACTIVE tool allowlist
 * @param {string} [forced] an explicit tier from behavior.persona_tier — a caller
 *        that knows better than the inference wins, so a general-purpose task can
 *        say so even when it happens to hold editing tools.
 * @returns {'develop'|'general'|'scoped'}
 */
export function personaTier(toolNames, forced = null) {
    if (forced && PERSONA_TIERS.includes(forced)) return forced;
    const names = Array.isArray(toolNames) ? toolNames : [];
    const canEdit = names.some(n => EDIT_TOOLS.has(n));
    const canExec = names.includes('run_command');
    const canProduce = names.some(n => PRODUCE_TOOLS.has(n));

    // Editing AND running is the code loop: make a change, prove it works. Running
    // commands without being able to edit is an automation task, which is still
    // this tier — it acts on the machine and has to verify what it did.
    if (canEdit && canExec) return 'develop';
    if (canExec) return 'develop';
    if (canEdit || canProduce) return 'general';
    return 'scoped';
}

/**
 * The persona text for a tier.
 *
 * `general` is deliberately NOT a shortened `develop`. It describes the work on its
 * own terms — gather, verify, deliver a document — because the previous slim prompt
 * told a report-writing agent nothing about how to do its job.
 *
 * @param {'develop'|'general'|'scoped'} tier
 * @param {string} outputLanguage
 */
export function personaFor(tier, outputLanguage) {
    const lang = `IMPORTANT: Final responses to the USER must be in ${outputLanguage}. `
        + `Internal reasoning may be in any language.`;

    if (tier === 'develop') {
        return `You are an elite autonomous software engineer integrated into J.H AI Agent.
You explore codebases, edit files, search, and run commands using the provided tools.
Act decisively: prefer doing the work over lengthy introspection. Verify after every change. When something fails, deduce the root cause and self-correct.
${lang}`;
    }

    if (tier === 'general') {
        return `You are a capable autonomous assistant integrated into J.H AI Agent. You handle general work, not only code.
Your job is to get real tasks done end to end: gather the material you need, reason over it, and DELIVER a concrete result the user can use.

How to work:
- Gather first. Read the actual files, sheets and pages involved rather than assuming — for .xlsx/.xls/.ods/.docx/.pptx always use read_office, never a shell.
- Check your own work. Re-read what you wrote, re-add the figures you reported, and confirm any source you cite exists. A confident wrong answer is worse than a slow one.
- Produce the artefact the request implies: a spreadsheet with write_xlsx, a document with write_docx, prose with write_file, and present_result for what the user should read.
- Say what you could not determine. Leaving a gap visible is part of the deliverable; filling it with a guess is not.
${lang}`;
    }

    // scoped: a read-only lookup or a single app intent. Long guidance here is pure
    // token cost on a call that does one thing.
    return `You are a helpful AI assistant embedded in J.H AI Agent, acting as a tool-using assistant for an integrated application.
Use the provided tools to obtain what you need, then deliver a clear, well-structured result.
${lang}`;
}

/**
 * Does this tier warrant the heavy rule block (edit protocol, path rules,
 * anti-loop guidance)?
 *
 * Only `develop`: those rules are about editing source and running commands, and on
 * a report-writing task they are noise the model has to read past.
 */
export function wantsEditingRules(tier) {
    return tier === 'develop';
}
