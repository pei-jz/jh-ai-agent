// apiCallView — the API-call inspector's content rules, without the dialog.

import { describe, it, expect } from 'vitest';
import {
    unescapeNewlines, formatMessages, apiCallTabs, callHeadline, callsTitle,
    slimEntries, redactHeaders, MAX_MESSAGE_CHARS,
} from '../apiCallView.js';

const keys = (entry) => apiCallTabs(entry).tabs.map(t => t.key);
const tab = (entry, key) => apiCallTabs(entry).tabs.find(t => t.key === key);

describe('unescapeNewlines', () => {
    // Raw provider envelopes carry these as literal two-character escapes; left
    // alone the whole payload renders as one unreadable line.
    it('turns literal escapes into real breaks', () => {
        expect(unescapeNewlines('a\\nb\\tc')).toBe('a\nb\tc');
        expect(unescapeNewlines('x\\r\\ny')).toBe('x\ny');
    });

    it('passes anything that is not a string straight through', () => {
        const o = { a: 1 };
        expect(unescapeNewlines(o)).toBe(o);
        expect(unescapeNewlines(null)).toBeNull();
    });
});

describe('formatMessages', () => {
    it('labels the array and numbers each message with its role', () => {
        const out = formatMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }], 'history');
        expect(out).toContain('=== history (2 messages) ===');
        expect(out).toContain('[0] user');
        expect(out).toContain('[1] assistant');
        expect(out).toContain('hi');
    });

    it('truncates a long message and says that it did', () => {
        const out = formatMessages([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 500) }], 'h');
        expect(out).toContain('…(truncated)');
        expect(out.length).toBeLessThan(MAX_MESSAGE_CHARS + 500);
    });

    it('serialises structured content rather than showing [object Object]', () => {
        expect(formatMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'h'))
            .toContain('"type": "text"');
    });

    it('names a message with no role rather than leaving a gap', () => {
        expect(formatMessages([{ content: 'x' }], 'h')).toContain('[0] unknown');
    });
});

describe('apiCallTabs — which tabs exist', () => {
    // An empty tab is a dead end: it looks like content that failed to load.
    it('offers only the tabs that have something in them', () => {
        expect(keys({ request: {}, response: 'ok' })).toEqual(['response']);
    });

    it('offers every tab a full entry supports', () => {
        const entry = {
            request: {
                sent_request: '{"model":"x"}',
                model: 'gpt-4o', temperature: 0.2,
                system_prompt: 'You are helpful.',
                history: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'read_file' }],
            },
            response: 'done',
            headers: { 'x-request-id': 'abc' },
        };
        expect(keys(entry)).toEqual(['sent', 'params', 'system', 'history', 'tools', 'response', 'headers']);
    });

    it('reads `messages` when the entry has no `history`', () => {
        const t = tab({ request: { messages: [{ role: 'user', content: 'a' }] } }, 'history');
        expect(t.label).toContain('(1)');
        expect(t.content).toContain('[0] user');
    });

    // Response is always present: a call with neither a response nor an error
    // still has to show something, or the entry looks like it never happened.
    it('always offers Response, even when empty', () => {
        expect(tab({ request: {} }, 'response').content).toBe('(empty)');
    });

    it('shows the error in the Response tab when the call failed', () => {
        expect(tab({ request: {}, error: 'connection reset' }, 'response').content).toBe('connection reset');
    });

    it('counts the history and the tools in their labels', () => {
        const entry = { request: { history: [1, 2, 3].map(i => ({ role: 'user', content: String(i) })), tools: [{}, {}] } };
        expect(tab(entry, 'history').label).toContain('(3)');
        expect(tab(entry, 'tools').label).toContain('(2)');
    });
});

describe('apiCallTabs — Params', () => {
    it('collects the scalar request fields', () => {
        const t = tab({ request: { model: 'gpt-4o', temperature: 0.2, max_tokens: 4096 } }, 'params');
        expect(JSON.parse(t.content)).toEqual({ model: 'gpt-4o', temperature: 0.2, max_tokens: 4096 });
    });

    it('does not repeat what already has its own tab', () => {
        const t = tab({
            request: {
                model: 'x', system_prompt: 's', history: [], tools: [],
                url: 'u', headers: {}, sent_request: '{}',
            },
        }, 'params');
        expect(JSON.parse(t.content)).toEqual({ model: 'x' });
    });

    // Native tool calling emits `thought: ""`, which read as a real parameter.
    it('drops empty strings rather than listing them as parameters', () => {
        expect(tab({ request: { thought: '   ', model: 'x' } }, 'params').content).not.toContain('thought');
    });

    it('offers no Params tab when there are none', () => {
        expect(keys({ request: { system_prompt: 's' } })).not.toContain('params');
    });
});

describe('apiCallTabs — which tab opens', () => {
    // The as-sent body is the request as actually thrown at the provider —
    // cache_control markers, the stable/volatile system split, send order.
    it('opens on the as-sent body when there is one', () => {
        const r = apiCallTabs({ request: { sent_request: '{}', history: [{ role: 'user', content: 'a' }] } });
        expect(r.tabs[r.defaultIndex].key).toBe('sent');
    });

    it('falls back to History when nothing was captured as sent', () => {
        const r = apiCallTabs({ request: { history: [{ role: 'user', content: 'a' }], model: 'x' } });
        expect(r.tabs[r.defaultIndex].key).toBe('history');
    });

    it('opens on the first tab when there is neither', () => {
        const r = apiCallTabs({ request: {}, response: 'ok' });
        expect(r.defaultIndex).toBe(0);
    });

    it('serialises a structured sent_request instead of showing [object Object]', () => {
        expect(tab({ request: { sent_request: { model: 'x' } } }, 'sent').content).toContain('"model": "x"');
    });
});

describe('apiCallTabs — malformed input', () => {
    it('parses a request that arrived as a JSON string', () => {
        expect(keys({ request: '{"model":"x"}' })).toContain('params');
    });

    it('survives a request that is neither an object nor JSON', () => {
        expect(() => apiCallTabs({ request: 'not json' })).not.toThrow();
        expect(() => apiCallTabs({})).not.toThrow();
        expect(() => apiCallTabs()).not.toThrow();
    });
});

describe('redactHeaders', () => {
    // ai.rs destroys the credential before it leaves the process. This is the
    // second layer: the modal is what gets screenshotted and screen-shared, so a
    // value that still LOOKS like a credential is masked again rather than
    // trusted to have been handled upstream.
    it('destroys a credential value that arrived unredacted', () => {
        const out = redactHeaders({ authorization: 'Bearer sk-proj-abcdef123456' });
        expect(out.authorization).not.toContain('sk-proj');
        expect(out.authorization).not.toContain('abcdef123456');
    });

    // Which scheme was used is part of what went wrong when a call is rejected.
    it('keeps the auth scheme and says a key was attached', () => {
        expect(redactHeaders({ authorization: 'Bearer sk-1' }).authorization).toBe('Bearer ****  (set)');
        expect(redactHeaders({ 'x-api-key': 'sk-ant-1' })['x-api-key']).toBe('****  (set)');
    });

    it('covers every credential header shape, whatever the casing', () => {
        for (const name of ['Authorization', 'X-Api-Key', 'api-key', 'x-goog-api-key', 'Cookie', 'proxy-authorization']) {
            const out = redactHeaders({ [name]: 'TOPSECRET' });
            expect(out[name]).not.toContain('TOPSECRET');
        }
    });

    // These are the ones worth reading: prompt caching is judged from the beta
    // flags, and content-type explains a 400.
    it('shows ordinary headers in full', () => {
        const out = redactHeaders({
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31',
        });
        expect(out['anthropic-beta']).toBe('prompt-caching-2024-07-31');
        expect(out['content-type']).toBe('application/json');
    });

    // Masking an already-masked value would turn "Bearer ****  (set)" into
    // "Bearer ****  (set)" again — harmless — but re-masking a scheme-less one
    // would lose the "(set)" that says the key was there.
    it('leaves an already-redacted value alone', () => {
        expect(redactHeaders({ authorization: 'Bearer ****  (set)' }).authorization).toBe('Bearer ****  (set)');
        expect(redactHeaders({ 'x-api-key': '****  (set)' })['x-api-key']).toBe('****  (set)');
    });

    it('survives a missing or malformed map', () => {
        expect(redactHeaders(undefined)).toEqual({});
        expect(redactHeaders(null)).toEqual({});
        expect(redactHeaders('not an object')).toEqual({});
    });
});

describe('the Headers tab', () => {
    // It existed but could never appear: nothing ever populated `headers`, so
    // the tab was a dead affordance for as long as it had been there.
    it('appears once the call recorded its headers', () => {
        const t = apiCallTabs({
            request: {},
            headers: { 'content-type': 'application/json', authorization: 'Bearer ****  (set)' },
        }).tabs.find(x => x.key === 'headers');
        expect(t).toBeTruthy();
        expect(t.content).toContain('content-type');
    });

    it('never carries a key into the panel', () => {
        const t = apiCallTabs({ request: {}, headers: { authorization: 'Bearer sk-LEAK' } })
            .tabs.find(x => x.key === 'headers');
        expect(t.content).not.toContain('sk-LEAK');
        expect(t.content).toContain('(set)');
    });

    // A call that never left has no headers; an empty "{}" tab is a dead end.
    it('stays absent when the call recorded none', () => {
        expect(apiCallTabs({ request: {} }).tabs.map(x => x.key)).not.toContain('headers');
        expect(apiCallTabs({ request: {}, headers: {} }).tabs.map(x => x.key)).not.toContain('headers');
    });
});

describe('callHeadline', () => {
    it('names a tool call by its tool', () => {
        expect(callHeadline({ method: 'TOOL', name: 'read_file' }).method).toBe('TOOL:read_file');
    });

    it('defaults an unlabelled call to CHAT', () => {
        expect(callHeadline({}).method).toBe('CHAT');
    });

    it('flags a failure by status or by a thrown error', () => {
        expect(callHeadline({ status: 500 }).isError).toBe(true);
        expect(callHeadline({ error: 'timeout' }).isError).toBe(true);
        expect(callHeadline({ status: 200 }).isError).toBe(false);
    });

    it('spells out the cache split only when there is one', () => {
        const plain = callHeadline({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
        expect(plain.usage).toBe('↑10 / ↓2 / total: 12 tokens');
        const cached = callHeadline({
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 112, cache_read_input_tokens: 100 },
        });
        expect(cached.usage).toContain('cached 100');
    });

    it('says nothing about usage when the call reported none', () => {
        expect(callHeadline({}).usage).toBe('');
    });
});

describe('callsTitle', () => {
    it('totals the calls, the tokens and the time', () => {
        expect(callsTitle([
            { usage: { prompt_tokens: 10, completion_tokens: 1 }, duration: 100 },
            { usage: { prompt_tokens: 5, completion_tokens: 2 }, duration: 250 },
        ])).toBe('🔌 API Calls (2) · ↑15t ↓3t · 350ms total');
    });

    it('reads zero for an empty set rather than NaN', () => {
        expect(callsTitle([])).toBe('🔌 API Calls (0) · ↑0t ↓0t · 0ms total');
        expect(callsTitle()).not.toMatch(/NaN/);
    });
});

describe('slimEntries', () => {
    // Listing and replay strip the heavy fields — without that the payload is
    // O(steps²). The full record is fetched only for calls actually opened.
    it('picks out the entries whose payload was stripped', () => {
        const entries = [
            { request: { _slim: true }, _idx: 3 },
            { request: { history: [] } },
            { request: { _slim: true } },        // no index — nothing to fetch with
        ];
        expect(slimEntries(entries)).toHaveLength(1);
        expect(slimEntries(entries)[0]._idx).toBe(3);
    });

    it('finds nothing to fetch for an ordinary set', () => {
        expect(slimEntries([{ request: {} }])).toEqual([]);
        expect(slimEntries()).toEqual([]);
    });
});
