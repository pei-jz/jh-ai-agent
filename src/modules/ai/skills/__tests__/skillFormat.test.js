// skillFormat — what a skill file says about itself.

import { describe, it, expect } from 'vitest';
import {
    parseFrontmatter, asList, skillMeta, skillCatalogue, skillPayload,
    isValidSkillName, SKILL_ENTRY, BUNDLE_DIRS,
} from '../skillFormat.js';

const withFm = (fm, body) => `---\n${fm}\n---\n${body}`;

describe('parseFrontmatter', () => {
    it('splits the header from the body', () => {
        const { meta, body } = parseFrontmatter(withFm('name: a\ndescription: does a thing', '# Title\n\ntext'));
        expect(meta).toEqual({ name: 'a', description: 'does a thing' });
        expect(body).toBe('# Title\n\ntext');
    });

    it('leaves a file with no header entirely as body', () => {
        expect(parseFrontmatter('# Title\ntext')).toEqual({ meta: {}, body: '# Title\ntext' });
    });

    // A `---` that is not at the very top is a horizontal rule, not a header.
    it('only reads a header at the start of the file', () => {
        const src = 'intro\n---\nname: a\n---\n';
        expect(parseFrontmatter(src).meta).toEqual({});
    });

    // Losing the metadata is recoverable; losing the skill is not.
    it('keeps the body when the header cannot be parsed', () => {
        const { meta, body } = parseFrontmatter(withFm('this is not key: value\nnor: is-this-wrong', 'BODY'));
        expect(body).toBe('BODY');
        expect(meta.nor).toBe('is-this-wrong');
    });

    it('reads quoted values, lists, booleans and comments', () => {
        const { meta } = parseFrontmatter(withFm(
            '# a comment\ntitle: "Excel: the report"\nallowed-tools: [read_office, write_xlsx]\ndraft: true',
            'x'));
        expect(meta.title).toBe('Excel: the report');
        expect(meta['allowed-tools']).toEqual(['read_office', 'write_xlsx']);
        expect(meta.draft).toBe(true);
    });

    it('handles CRLF line endings', () => {
        const { meta, body } = parseFrontmatter('---\r\nname: a\r\n---\r\nBODY');
        expect(meta.name).toBe('a');
        expect(body).toBe('BODY');
    });

    it('survives a null or empty input', () => {
        expect(parseFrontmatter(null)).toEqual({ meta: {}, body: '' });
        expect(parseFrontmatter('')).toEqual({ meta: {}, body: '' });
    });
});

describe('asList', () => {
    it('accepts a list or one comma-separated string', () => {
        expect(asList(['a', 'b'])).toEqual(['a', 'b']);
        expect(asList('a, b')).toEqual(['a', 'b']);
        expect(asList('a')).toEqual(['a']);
    });

    it('is empty for anything else', () => {
        expect(asList(undefined)).toEqual([]);
        expect(asList('')).toEqual([]);
        expect(asList(42)).toEqual([]);
    });
});

describe('skillMeta — with frontmatter', () => {
    const src = withFm(
        'description: Build the monthly report from the raw export.\nallowed-tools: read_office, write_xlsx',
        '# Monthly report\n\nStep 1…');

    it('reads the description the catalogue needs', () => {
        expect(skillMeta('report', src).description).toBe('Build the monthly report from the raw export.');
    });

    it('takes the title from the heading when the header names none', () => {
        expect(skillMeta('report', src).title).toBe('Monthly report');
    });

    it('prefers an explicit title', () => {
        expect(skillMeta('report', withFm('title: Custom', '# Heading')).title).toBe('Custom');
    });

    it('reads allowed-tools either way round', () => {
        expect(skillMeta('report', src).allowedTools).toEqual(['read_office', 'write_xlsx']);
        expect(skillMeta('r', withFm('allowedTools: [a]', 'x')).allowedTools).toEqual(['a']);
    });

    it('hands back the body without the header', () => {
        expect(skillMeta('report', src).body).toBe('# Monthly report\n\nStep 1…');
    });

    // The FILENAME is what `/…` types and what read_skill looks up. A header
    // that renamed the skill would make one of the two wrong, so it is reported
    // rather than applied.
    it('reports a header name that disagrees with the filename, and keeps the filename', () => {
        const s = skillMeta('report', withFm('name: something-else', '# T'));
        expect(s.name).toBe('report');
        expect(s.nameMismatch).toBe('something-else');
    });

    it('reports no mismatch when they agree', () => {
        expect(skillMeta('report', withFm('name: report', '# T')).nameMismatch).toBeNull();
    });
});

describe('skillMeta — the old convention', () => {
    // Every skill written before frontmatter looks like this, and must keep
    // working untouched.
    it('takes the title from the first line and the description from the next', () => {
        const s = skillMeta('legacy', '# Register a backlog item\nCreates the ticket and links it.\n\nSteps…');
        expect(s.title).toBe('Register a backlog item');
        expect(s.description).toBe('Creates the ticket and links it.');
    });

    it('skips blank lines and further headings when looking for the description', () => {
        const s = skillMeta('legacy', '# Title\n\n\n## Section\nThe real first sentence.');
        expect(s.description).toBe('The real first sentence.');
    });

    it('falls back to the name when the file is only a heading', () => {
        expect(skillMeta('lonely', '# Just a title').description).toBe('');
        expect(skillMeta('lonely', '').title).toBe('lonely');
    });

    it('truncates a very long first paragraph rather than pasting it into the catalogue', () => {
        const s = skillMeta('long', `# T\n${'x'.repeat(500)}`);
        expect(s.description.length).toBeLessThan(210);
        expect(s.description.endsWith('…')).toBe(true);
    });
});

describe('skillCatalogue', () => {
    const skills = [
        { name: 'report', description: 'Build the monthly report.' },
        { name: 'triage', description: 'Sort incoming issues.', scripts: ['scripts/sort.py'] },
        { name: 'audit', description: 'Check the ledger.', allowedTools: ['read_office'] },
    ];

    it('lists one line per skill, with no bodies', () => {
        const out = skillCatalogue(skills);
        expect(out).toContain('- report: Build the monthly report.');
        expect(out).toContain('- triage: Sort incoming issues.');
        expect(out.split('\n').filter(l => l.startsWith('- '))).toHaveLength(3);
    });

    // The whole point: the agent must fetch a body rather than guess at it.
    it('tells the agent to load a skill with read_skill', () => {
        expect(skillCatalogue(skills)).toMatch(/read_skill/);
        expect(skillCatalogue(skills)).toMatch(/Do not guess/i);
    });

    it('mentions bundled scripts and expected tools', () => {
        const out = skillCatalogue(skills);
        expect(out).toContain('[1 script]');
        expect(out).toContain('[tools: read_office]');
    });

    it('says nothing at all when there are no skills', () => {
        expect(skillCatalogue([])).toBe('');
        expect(skillCatalogue()).toBe('');
    });

    it('ignores an entry with no name rather than printing a blank row', () => {
        expect(skillCatalogue([{ description: 'orphan' }, ...skills]).split('\n')
            .filter(l => l.startsWith('- '))).toHaveLength(3);
    });

    it('flattens a multi-line description onto its row', () => {
        expect(skillCatalogue([{ name: 'a', description: 'one\ntwo' }])).toContain('- a: one two');
    });

    it('says so when a skill has no description at all', () => {
        expect(skillCatalogue([{ name: 'a' }])).toContain('(no description)');
    });
});

describe('skillPayload', () => {
    const skill = { name: 'report', title: 'Monthly report', description: 'Build it.', allowedTools: ['write_xlsx'] };

    it('names the skill and carries its body', () => {
        const out = skillPayload(skill, { body: 'Step 1' });
        expect(out).toContain('# Skill: Monthly report (/report)');
        expect(out).toContain('Build it.');
        expect(out).toContain('Step 1');
    });

    // A skill that ships a script should not have to explain where it lives.
    it('lists bundled files with paths that can be acted on directly', () => {
        const out = skillPayload(skill, {
            body: 'run it',
            files: [{ rel: 'scripts/sort.py', path: 'C:/cfg/skills/report/scripts/sort.py' }],
        });
        expect(out).toContain('scripts/sort.py → C:/cfg/skills/report/scripts/sort.py');
    });

    it('names the directory when there is nothing bundled yet', () => {
        expect(skillPayload(skill, { body: 'x', dir: 'C:/cfg/skills/report' }))
            .toContain('C:/cfg/skills/report');
    });

    it('says which tools the skill expects', () => {
        expect(skillPayload(skill, { body: 'x' })).toContain('write_xlsx');
    });

    it('survives a skill with nothing but a body', () => {
        expect(skillPayload({ name: 'x', title: 'x' }, { body: 'b' })).toContain('b');
    });
});

describe('isValidSkillName', () => {
    it('accepts what can be typed after a slash and used as a folder', () => {
        expect(isValidSkillName('excel-report')).toBe(true);
        expect(isValidSkillName('a_1')).toBe(true);
    });

    // These are the ones that would escape the skills directory.
    it('rejects separators and traversal', () => {
        for (const bad of ['../x', 'a/b', 'a\\b', 'a b', '', null, '.']) {
            expect(isValidSkillName(bad)).toBe(false);
        }
    });
});

describe('the layout constants', () => {
    it('names the directory entry file and the bundles it may carry', () => {
        expect(SKILL_ENTRY).toBe('SKILL.md');
        expect(BUNDLE_DIRS).toContain('scripts');
        expect(BUNDLE_DIRS).toContain('references');
    });
});
