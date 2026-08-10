// Protocol parsing: recovering a tool call a model emitted as TEXT rather than
// through the function-call API. No DOM, so this runs in node — the jsdom pragma this
// file used to carry was only there because renderMessageHtml pulled in resultView.
import { describe, it, expect } from 'vitest';
import {
    extractToolCall,
} from '../chatRenderer.js';

describe('extractToolCall', () => {
    it('returns null for empty input', () => {
        expect(extractToolCall('')).toBeNull();
        expect(extractToolCall(null)).toBeNull();
    });

    it('parses a fenced ```json block', () => {
        const r = extractToolCall('text\n```json\n{"name":"read_file","args":{"path":"a"}}\n```\nmore');
        expect(r).toEqual({ name: 'read_file', args: { path: 'a' } });
    });

    it('parses a bare JSON object', () => {
        expect(extractToolCall('{"name":"x"}')).toEqual({ name: 'x' });
    });

    it('returns null for non-JSON text', () => {
        expect(extractToolCall('just some prose')).toBeNull();
    });

    it('returns null for malformed JSON in a fence', () => {
        expect(extractToolCall('```json\n{not valid}\n```')).toBeNull();
    });
});

// NOTE: the parseThought / renderAgentSteps / renderMessageHtml /
// renderResultStatsChips tests are gone with the functions.
//   • renderMessageHtml → svelte/chat/__tests__/messages.test.js
//   • renderResultStatsChips → statChips, in monitor/__tests__/timelineItems.test.js
//   • renderAgentSteps had no caller even before the migration
//   • parseThought was only reachable through renderAgentSteps
