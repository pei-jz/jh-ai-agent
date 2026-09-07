// ContextBuilder.getSystemPrompt — what the model actually receives.
//
// The prompt is where several separately-correct pieces have to agree: the
// workspace's own rules must arrive intact, the cacheable prefix must stay
// byte-stable across steps, and the protocol section must match whichever API
// the agent is about to call. Each of those has bitten before, so they're
// pinned here rather than left to inspection.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Default bridge: config reads succeed with defaults, file reads report "absent"
// as null. Individual tests override to supply a specific file.
const defaultInvoke = async (cmd) => (cmd === 'get_ai_config' ? {} : null);
const invoke = vi.fn(defaultInvoke);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

// Local-first memory (P5): stored under the app config dir, injected into the
// prompt. `configDir` and its contents are supplied per-test.
let configDir = 'C:/cfg';
let localMemoryJson = '';
vi.mock('../memory/localMemory.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        readLocalMemory: async () => {
            if (!localMemoryJson) return { entries: [] };
            try { return { entries: JSON.parse(localMemoryJson).entries }; } catch (_) { return { entries: [] }; }
        },
    };
});

let projectSummary = '';
let projectInstructions = '';
vi.mock('../ProjectContext.js', () => ({
    projectContext: {
        getPromptContext: () => projectSummary,
        getProjectInstructions: () => projectInstructions,
    },
}));

vi.mock('../ConversationMemory.js', () => ({
    conversationMemory: { getPromptContext: async () => '', getFactsContext: async () => '' },
}));

let nativeTools = true;
/** null ⇒ the provider decides, which is a real configuration. */
let maxOutput = 8192;
vi.mock('../LLMService.js', () => ({
    default: {
        getCurrentModel: () => 'openai:gpt-4o',
        getEffectiveModelLimit: () => 100000,
        getMaxOutputTokens: () => maxOutput,
        supportsNativeTools: () => nativeTools,
        getCurrentProvider: () => 'openai',
    },
}));

const { contextBuilder, ContextBuilder } = await import('../ContextBuilder.js');

/** A ToolExecutor stand-in exposing only what the prompt builder reads. */
function fakeExecutor(toolNames = ['read_file', 'write_file', 'finish_task']) {
    return {
        workspacePath: 'C:/work/proj',
        getToolsForNativeAPI: () => toolNames.map(n => ({
            type: 'function',
            function: { name: n, description: `${n} desc`, parameters: { type: 'object', properties: {} } },
        })),
        getActiveToolDefinitions: () => toolNames.map(n => ({ name: n, description: `${n} desc` })),
        getSessionArtifactDir: () => '.agent/artifacts',
        getCurrentSessionId: () => 'sess_1',
    };
}

const build = (opts = {}) => contextBuilder.getSystemPrompt(
    opts.root ?? 'C:/work/proj',
    opts.executor ?? fakeExecutor(),
    null, opts.editContext ?? null, opts.kis ?? '', opts.query ?? 'do the thing', null,
);

beforeEach(() => {
    projectSummary = '\n[Project Structure Overview]\nsrc/\n';
    projectInstructions = '';
    nativeTools = true;
    configDir = 'C:/cfg';
    localMemoryJson = '';
    invoke.mockReset();
    invoke.mockImplementation(defaultInvoke);
    contextBuilder.invalidateStaticCache();
    contextBuilder._configDir = undefined; // reset the per-process dir cache
});

describe('project instructions (.agent/instructions.md)', () => {
    it('is absent from the prompt when the workspace has no file', async () => {
        const p = await build();
        expect(p).not.toContain('<project_instructions');
    });

    it('gets its own high-authority block naming the source file', async () => {
        projectInstructions = 'Run npm test after every edit.';
        const p = await build();
        expect(p).toContain('<project_instructions');
        expect(p).toContain('authority="project"');
        expect(p).toContain('.agent/instructions.md');
        expect(p).toContain('Run npm test after every edit.');
    });

    it('survives verbatim even when the auto-generated summary is huge', async () => {
        // The summary is what gets trimmed; the user's rules must not be.
        projectSummary = '[Project Structure Overview]\n' + 'src/file.js\n'.repeat(20000);
        projectInstructions = ['## Rules', '- FIRST RULE MARKER', '- middle rule', '- LAST RULE MARKER'].join('\n');
        const p = await build();
        expect(p).toContain('FIRST RULE MARKER');
        expect(p).toContain('LAST RULE MARKER');   // the old code cut the middle out
        expect(p).toContain('middle rule');
    });

    it('appears AFTER the project summary, so it reads as the authority over it', async () => {
        projectInstructions = 'RULES-HERE';
        const p = await build();
        expect(p.indexOf('<project_summary>')).toBeLessThan(p.indexOf('<project_instructions'));
    });

    it('lands in the CACHEABLE region (before the cache-break sentinel)', async () => {
        projectInstructions = 'RULES-HERE';
        const p = await build();
        const sentinel = p.indexOf(ContextBuilder.SYSTEM_CACHE_BREAK);
        if (sentinel !== -1) {
            expect(p.indexOf('<project_instructions')).toBeLessThan(sentinel);
        }
    });
});

describe('static-prefix cache', () => {
    it('reuses the built prefix across calls with unchanged inputs', async () => {
        const a = await build();
        const b = await build();
        expect(a).toBe(b);
    });

    it('REBUILDS when instructions.md changes mid-session (hash in the cache key)', async () => {
        projectInstructions = 'version one';
        const before = await build();
        projectInstructions = 'version two';
        const after = await build();
        expect(before).not.toBe(after);
        expect(after).toContain('version two');
        expect(after).not.toContain('version one');
    });

    it('rebuilds when the persona file changes', async () => {
        invoke.mockImplementation(async (cmd, args) => {
            if (String(args?.path || '').endsWith('agents/default.md')) return 'PERSONA-A';
            return defaultInvoke(cmd);
        });
        const a = await build();
        invoke.mockImplementation(async (cmd, args) => {
            if (String(args?.path || '').endsWith('agents/default.md')) return 'PERSONA-B';
            return defaultInvoke(cmd);
        });
        const b = await build();
        expect(a).not.toBe(b);
    });
});

describe('workspace persona (.agent/agents/default.md)', () => {
    const withPersona = (text) => invoke.mockImplementation(async (cmd, args) => {
        if (String(args?.path || '').endsWith('agents/default.md')) return text;
        return defaultInvoke(cmd);
    });

    it('APPENDS to the built-in persona so the safety rules survive', async () => {
        withPersona('Always answer tersely.');
        const p = await build();
        expect(p).toContain('Always answer tersely.');
        expect(p).toContain('<workspace_persona>');
        expect(p).toMatch(/J\.H AI Agent/);   // built-in persona still present
    });

    it('replaces wholesale only with the explicit marker', async () => {
        withPersona('<!-- replace -->\nI am the whole persona.');
        const p = await build();
        expect(p).toContain('I am the whole persona.');
        expect(p).not.toContain('<workspace_persona>');
    });
});

describe('protocol section matches the API being used', () => {
    it('native mode does NOT re-list the tools (they go in the API tools field)', async () => {
        nativeTools = true;
        const p = await build();
        expect(p).not.toContain('<available_tools>');
    });

    it('JSON mode DOES list the tools and the envelope protocol', async () => {
        nativeTools = false;
        const p = await build();
        expect(p).toContain('<available_tools>');
    });
});

describe('cache-break sentinel', () => {
    it('separates the stable prefix from the volatile tail when there is one', async () => {
        const p = await build();
        const count = p.split(ContextBuilder.SYSTEM_CACHE_BREAK).length - 1;
        expect(count).toBeLessThanOrEqual(1);   // never more than one split point
    });

    it('places the environment + project summary in the stable region', async () => {
        const p = await build();
        const sentinel = p.indexOf(ContextBuilder.SYSTEM_CACHE_BREAK);
        const stable = sentinel === -1 ? p : p.slice(0, sentinel);
        expect(stable).toContain('<environment>');
        expect(stable).toContain('<project_summary>');
    });
});

describe('developer memory (localMemory, P5)', () => {
    it('is injected as a labelled block when the store has entries', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? {} : (cmd === 'get_app_config_dir' ? configDir : null)));
        localMemoryJson = '{"entries":[{"text":"Rust + Svelte","category":"preference"}]}';
        const p = await build();
        expect(p).toContain('<developer_memory>');
        expect(p).toContain('[preference] Rust + Svelte');
    });

    it('is absent when the store is empty', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? {} : (cmd === 'get_app_config_dir' ? configDir : null)));
        const p = await build();
        expect(p).not.toContain('<developer_memory>');
    });

    it('is absent when the backend has no get_app_config_dir', async () => {
        // defaultInvoke returns null for every non-config command.
        const p = await build();
        expect(p).not.toContain('<developer_memory>');
    });

    it('lands in the CACHEABLE (stable) region', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? {} : (cmd === 'get_app_config_dir' ? configDir : null)));
        localMemoryJson = '{"entries":[{"text":"Rust + Svelte","category":"preference"}]}';
        const p = await build();
        const sentinel = p.indexOf(ContextBuilder.SYSTEM_CACHE_BREAK);
        const stable = sentinel === -1 ? p : p.slice(0, sentinel);
        expect(stable).toContain('<developer_memory>');
    });

    it('REBUILDS the cached prefix when the store changes mid-run', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? {} : (cmd === 'get_app_config_dir' ? configDir : null)));
        localMemoryJson = '{"entries":[{"text":"version one","category":"preference"}]}';
        const before = await build();
        localMemoryJson = '{"entries":[{"text":"version two","category":"preference"}]}';
        const after = await build();
        expect(before).not.toBe(after);
        expect(after).toContain('version two');
        expect(after).not.toContain('version one');
    });
});

// The catalogue is the whole progressive-disclosure mechanism: the agent is
// given every skill's NAME and DESCRIPTION, and reads a body with `read_skill`
// only when one applies. It travels as kisContext, so what matters here is that
// it survives the trip and lands in the CACHEABLE half of the prompt — a
// catalogue that moved between steps would break the prefix cache on every run.
describe('the skill catalogue', () => {
    const CATALOGUE = ['The following SKILLS are available.', '', '- report: Build the monthly report.'].join('\n');

    it('reaches the model', async () => {
        expect(await build({ kis: CATALOGUE })).toContain('- report: Build the monthly report.');
    });

    it('is wrapped so the model can tell it apart from the task', async () => {
        const p = await build({ kis: CATALOGUE });
        expect(p).toContain('<knowledge_items>');
        expect(p.indexOf('- report:')).toBeGreaterThan(p.indexOf('<knowledge_items>'));
    });

    it('adds nothing when no skills are installed', async () => {
        expect(await build({ kis: '' })).not.toContain('<knowledge_items>');
    });
});

// The ceiling the agent kept walking into without being told it was there.
//
// A tool call carrying a whole workbook can exceed the REPLY limit, and the
// reply is then cut off mid-argument: what reaches the tool is a call with a
// parameter missing, which reads as a mistake the model did not make. One run
// spent nine steps shrinking content that had never been the problem.
describe('the reply-size ceiling', () => {
    it('states the number, what happens at it, and the way round it', async () => {
        const prompt = await build();
        expect(prompt).toContain('<reply_limit_tokens>8,192</reply_limit_tokens>');
        expect(prompt).toMatch(/CUT OFF/);
        expect(prompt).toMatch(/in pieces/);
        // Not the context window — a different number with a different meaning.
        expect(prompt).toContain('<model_limit_tokens>100,000</model_limit_tokens>');
    });

    it('says nothing when the provider decides the limit', async () => {
        maxOutput = null;
        contextBuilder.invalidate?.();
        const prompt = await build();
        maxOutput = 8192;
        expect(prompt).not.toContain('reply_limit_tokens');
    });
});
