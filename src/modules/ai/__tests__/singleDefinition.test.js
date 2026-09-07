// Facts that must have exactly one definition.
//
// This session found four of these: `modeName` and `MODE_ICON` written twice
// each, the emoji-stripping regex copied per view, and the shared CSS
// vocabulary living inside one component's scoped style. Every one of them had
// identical copies, so everything worked — which is precisely the state a
// duplicate is in right before someone edits one of them.
//
// A grep is a blunt instrument, and that is the point: it catches the copy at
// the moment it is written, not months later when the two have drifted and the
// symptom is a mode that shows the wrong icon on one screen.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../../..');            // src/

function sourceFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) sourceFiles(p, out);
        else if (/\.(js|svelte)$/.test(name)) out.push([relative(src, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]);
    }
    return out;
}

const files = sourceFiles(src);

/** Files that DEFINE this name (an export or a local const/function). */
function definitionsOf(pattern) {
    return files
        .filter(([, text]) => pattern.test(text))
        .map(([path]) => path);
}

describe('how a mode is presented is decided once', () => {
    // Both lived in AgentModes AND in newTaskRequest/ModeDropdown, with the
    // same bodies. Adding a fifth agent mode would have updated one of them.
    it('modeName has one definition', () => {
        expect(definitionsOf(/^\s*export function modeName\s*\(|^\s*function modeName\s*\(/m))
            .toEqual(['modules/ai/AgentModes.js']);
    });

    it('MODE_ICON has one definition', () => {
        expect(definitionsOf(/^\s*(export )?const MODE_ICON\s*=/m))
            .toEqual(['modules/ai/AgentModes.js']);
    });

    // The regex that strips a mode's leading emoji was written out per view
    // before `modeName` existed. It must not come back.
    it('nothing strips the leading emoji by hand any more', () => {
        const offenders = files
            .filter(([path, text]) => path !== 'modules/ai/AgentModes.js'
                && /replace\(\/\^\\S\+\\s\+\//.test(text))
            .map(([path]) => path);
        expect(offenders).toEqual([]);
    });
});

describe('the credential-store account names are derived, not typed', () => {
    // `watcher:<id>` and `watcher-auth:<id>` are written by the form and read
    // by the backend. A mismatch fails as "no password stored" on a watcher the
    // user definitely gave one to — a puzzle with no evidence in it.
    it('each has one definition', () => {
        expect(definitionsOf(/^export function secretIdFor\s*\(/m))
            .toEqual(['modules/ai/triggers/WatcherManager.js']);
        expect(definitionsOf(/^export function authSecretIdFor\s*\(/m))
            .toEqual(['modules/ai/triggers/WatcherManager.js']);
    });

    it('no one builds those strings inline', () => {
        const offenders = files
            .filter(([path, text]) => path !== 'modules/ai/triggers/WatcherManager.js'
                && /`watcher(-auth)?:\$\{/.test(text))
            .map(([path]) => path);
        expect(offenders).toEqual([]);
    });
});
