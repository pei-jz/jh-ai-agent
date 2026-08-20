// skillFormat — what a skill file says about itself.
//
// A skill used to be a single .md whose FIRST LINE was its title and which had
// no description at all: `list_skill_files` returned `{name, path, title}`, and
// the `description` the UI and the slash popup asked for was always undefined.
// The whole body was then injected into every message that mentioned the skill.
//
// Two things follow from adding frontmatter, and they are the point of it:
//
//   • a skill can be OFFERED without being LOADED. The agent is given the name
//     and the description only — a catalogue — and reads the body with
//     `read_skill` when it decides the skill applies. A ten-page procedure costs
//     one line of context until it is actually needed.
//   • a skill can say what it needs (`allowed-tools`) and carry files beside it
//     (`scripts/`, `references/`), which a single .md has nowhere to put.
//
// Both layouts are read, because the flat one is what already exists on disk:
//
//   skills/<name>.md              flat — no room for anything but prose
//   skills/<name>/SKILL.md        directory — may carry scripts/ and references/

/** The file that carries a directory-form skill's instructions. */
export const SKILL_ENTRY = 'SKILL.md';

/** Subdirectories a skill may bundle. Anything else is ignored. */
export const BUNDLE_DIRS = ['scripts', 'references', 'assets'];

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split `---` frontmatter from the body.
 *
 * Deliberately NOT a YAML parser: a skill's header is a handful of scalars and
 * short lists, and pulling in a YAML dependency to read them would be a much
 * larger surface than the feature. Anything it cannot parse is left in `body`,
 * so a malformed header costs the metadata, never the skill.
 *
 * @returns {{meta: object, body: string}}
 */
export function parseFrontmatter(text) {
    const src = String(text ?? '');
    const m = src.match(FRONTMATTER);
    if (!m) return { meta: {}, body: src };

    const meta = {};
    for (const raw of m[1].split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const at = line.indexOf(':');
        if (at <= 0) continue;
        const key = line.slice(0, at).trim();
        meta[key] = parseScalar(line.slice(at + 1).trim());
    }
    return { meta, body: src.slice(m[0].length) };
}

/** `"a"` / `'a'` / `[a, b]` / `a, b` / `true` / `42` — the shapes a header uses. */
function parseScalar(value) {
    if (!value) return '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return splitList(value.slice(1, -1));
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}

const splitList = (s) => s.split(',').map(v => parseScalar(v.trim())).filter(v => v !== '');

/** A field that may be written as a list or as one comma-separated string. */
export function asList(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (typeof value === 'string') return splitList(value);
    return [];
}

/**
 * What a skill is called and what it is for.
 *
 * `name` from the frontmatter is IGNORED when it disagrees with the filename:
 * the filename is what `/…` types and what `read_skill` looks up, so letting a
 * header rename a skill would make one of the two wrong. It is validated
 * instead — a mismatch is worth telling the author about.
 *
 * With no frontmatter the old convention still holds: first line is the title,
 * and the first non-empty line after it is the description. That is what every
 * skill written so far looks like.
 */
export function skillMeta(name, text) {
    const { meta, body } = parseFrontmatter(text);
    const lines = body.split(/\r?\n/);
    const firstLine = (lines.find(l => l.trim()) || '').trim();
    const heading = firstLine.replace(/^#+\s*/, '').trim();

    const fmTitle = typeof meta.title === 'string' ? meta.title.trim() : '';
    const fmDesc = typeof meta.description === 'string' ? meta.description.trim() : '';

    return {
        name,
        title: fmTitle || heading || name,
        description: fmDesc || fallbackDescription(lines, firstLine),
        allowedTools: asList(meta['allowed-tools'] ?? meta.allowedTools),
        /** Set when the header names a different skill — surfaced, never applied. */
        nameMismatch: typeof meta.name === 'string' && meta.name.trim() && meta.name.trim() !== name
            ? meta.name.trim()
            : null,
        meta,
        body,
    };
}

/** The first real sentence under the heading, for a skill with no frontmatter. */
function fallbackDescription(lines, firstLine) {
    const at = lines.findIndex(l => l.trim() === firstLine);
    for (const line of lines.slice(at + 1)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        return t.length > 200 ? `${t.slice(0, 200)}…` : t;
    }
    return '';
}

/**
 * The catalogue handed to the agent: one line per skill, no bodies.
 *
 * This is the whole progressive-disclosure mechanism. It used to be the legacy
 * `.agent/skills.json` — a separate store the Skills tab could not edit and
 * `/…` could not see, so the two never held the same skills.
 */
export function skillCatalogue(skills = []) {
    const usable = skills.filter(s => s?.name);
    if (!usable.length) return '';
    const rows = usable.map(s => {
        const what = String(s.description || s.title || '').replace(/\s+/g, ' ').trim();
        const extras = [];
        if (s.scripts?.length) extras.push(`${s.scripts.length} script${s.scripts.length > 1 ? 's' : ''}`);
        if (s.allowedTools?.length) extras.push(`tools: ${s.allowedTools.join(', ')}`);
        return `- ${s.name}: ${what || '(no description)'}${extras.length ? ` [${extras.join('; ')}]` : ''}`;
    });
    return `The following SKILLS are available. Each is a written procedure for a
recurring job. Only the names and descriptions are listed — call \`read_skill\`
with a name to load one when it applies to what you are doing. Do not guess a
skill's contents from its description.

${rows.join('\n')}`;
}

/**
 * What `read_skill` hands back.
 *
 * The bundled files are listed with paths the agent can act on directly, so a
 * skill that ships a script does not have to explain where it lives.
 */
export function skillPayload(skill, { body, files = [], dir = '' } = {}) {
    const parts = [`# Skill: ${skill.title} (/${skill.name})`];
    if (skill.description) parts.push(skill.description);
    if (skill.allowedTools?.length) {
        parts.push(`Tools this skill expects: ${skill.allowedTools.join(', ')}`);
    }
    if (files.length) {
        parts.push(
            `Files bundled with this skill (absolute paths — run or read them directly):\n`
            + files.map(f => `- ${f.rel} → ${f.path}`).join('\n'),
        );
    } else if (dir) {
        parts.push(`Skill directory: ${dir}`);
    }
    parts.push('---', String(body ?? '').trim());
    return parts.join('\n\n');
}

/** A skill name that is safe as a path segment and typeable after "/". */
export function isValidSkillName(name) {
    return /^[a-zA-Z0-9_-]+$/.test(String(name ?? ''));
}
