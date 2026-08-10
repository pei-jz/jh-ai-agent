// lists — validation for the Templates and Skills tabs.
//
// Both create something addressable as a SLASH COMMAND, so the name is not
// cosmetic: an invalid one produces a command that can never be invoked, and the
// old flow discovered that only after saving. The rules were inline in two click
// handlers; here they are pure and shared.

/** Letters, numbers, hyphens, underscores — what a /command can be typed as. */
const COMMAND_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Is this a usable slash-command name?
 * @returns {string|null} the refusal to show, or null when valid
 */
export function commandNameRefusal(name) {
    const s = String(name || '').trim();
    if (!s) return 'Enter a command name.';
    if (!COMMAND_NAME.test(s)) {
        return 'Command names may only contain letters, numbers, hyphens, and underscores.';
    }
    return null;
}

/**
 * A prompt template needs a name, a label and a body.
 * @returns {string|null}
 */
export function templateRefusal(tpl = {}) {
    const nameProblem = commandNameRefusal(tpl.key);
    if (nameProblem) return nameProblem;
    if (!String(tpl.label || '').trim()) return 'Please enter a display name.';
    if (!String(tpl.prompt || '').trim()) return 'Please enter the prompt text.';
    return null;
}

/**
 * A skill needs a name (when new) and a body.
 *
 * `isEdit` skips the name check because the name is the FILE and is therefore not
 * editable — the form does not even show the field.
 *
 * @returns {string|null}
 */
export function skillRefusal(skill = {}, isEdit = false) {
    if (!isEdit) {
        const nameProblem = commandNameRefusal(skill.name);
        if (nameProblem) return nameProblem;
    }
    if (!String(skill.content || '').trim()) return 'Please enter the skill content.';
    return null;
}

// NOTE: no skillTitle here. SkillManager already derives a skill's display title
// from its first heading and exposes it on getAll(), so duplicating that rule would
// give the same question two answers.
