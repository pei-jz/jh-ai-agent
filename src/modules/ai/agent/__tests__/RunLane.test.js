// RunLane — shape × reach. docs/scratch/Report_20260913.md §5.
//
// The properties worth pinning are the defaults and the refusals, because those
// are what a caller gets by NOT thinking about this: an external app that sends
// nothing must land in the narrowest lane that still does something, and work
// without a workspace must be refused rather than run against the process cwd.

import { describe, it, expect } from 'vitest';
import {
    resolveLane, laneTools, appServers, usesProjectContext, laneLabel,
    TRANSFORM, ASK, BUILD, NONE, APP, WORKSPACE, ASK_MAX_STEPS,
} from '../RunLane.js';
import { WEB_TOOLS } from '../../tools/toolSets.js';

describe('resolveLane — explicit fields win', () => {
    it.each([
        [{ shape: 'ask', reach: 'none' }, ASK, NONE],
        [{ shape: 'ask', reach: 'app' }, ASK, APP],
        [{ shape: 'ask', reach: 'workspace' }, ASK, WORKSPACE],
        [{ shape: 'build', reach: 'workspace' }, BUILD, WORKSPACE],
    ])('%j → %s × %s', (behavior, shape, reach) => {
        const lane = resolveLane(behavior, { caller: 'JHEditor' });
        expect([lane.shape, lane.reach, lane.error]).toEqual([shape, reach, null]);
    });

    // A transform has no tools, so a reach would govern nothing — and a reach
    // that says "workspace" on a toolless call would be a claim with no effect.
    it('forces a transform to reach none, whatever was asked', () => {
        expect(resolveLane({ shape: 'transform', reach: 'workspace' }).reach).toBe(NONE);
    });
});

describe('resolveLane — legacy fields keep a defined meaning', () => {
    it('single_shot is a transform', () => {
        expect(resolveLane({ mode: 'single_shot' }, { caller: 'JHER' }).shape).toBe(TRANSFORM);
    });

    it('interaction ask/build carries over for this app', () => {
        expect(resolveLane({ interaction: 'ask' }, { caller: 'Composer' })).toMatchObject({ shape: ASK, reach: WORKSPACE });
        expect(resolveLane({ interaction: 'build' }, { caller: 'NewTask' })).toMatchObject({ shape: BUILD, reach: WORKSPACE });
    });

    it('this app saying nothing is build × workspace — what it has always been', () => {
        for (const caller of ['NewTask', 'Composer', 'Job', 'Trigger', 'Schedule']) {
            expect(resolveLane({ mode: 'iterative_agent' }, { caller })).toMatchObject({ shape: BUILD, reach: WORKSPACE, error: null });
        }
    });
});

describe('resolveLane — an external caller that says nothing gets the narrow lane', () => {
    // The failure this exists for: JHEditor's chat sent a workspace path and got
    // the file system. The server must not need the client to remember to narrow.
    it('is ask × app', () => {
        expect(resolveLane({ mode: 'iterative_agent' }, { caller: 'JHEditor' })).toMatchObject({ shape: ASK, reach: APP, external: true });
        expect(resolveLane({}, { caller: 'jhwbs' })).toMatchObject({ shape: ASK, reach: APP });
    });

    it('asking for build without also asking for a workspace is refused, not narrowed', () => {
        const lane = resolveLane({ interaction: 'build' }, { caller: 'JHEditor' });
        expect(lane.shape).toBe(BUILD);
        expect(lane.error).toMatch(/workspace/);
    });

    it('build × workspace is available when asked for explicitly', () => {
        expect(resolveLane({ shape: 'build', reach: 'workspace' }, { caller: 'JHEditor' }).error).toBeNull();
    });
});

describe('resolveLane — refusals and odd input', () => {
    it.each([NONE, APP])('build × %s is an error', (reach) => {
        expect(resolveLane({ shape: 'build', reach }, { caller: 'NewTask' }).error).toMatch(/workspace/);
    });

    it('ignores values it does not recognise rather than guessing from them', () => {
        expect(resolveLane({ shape: 'chat', reach: 'everything' }, { caller: 'NewTask' }))
            .toMatchObject({ shape: BUILD, reach: WORKSPACE });
    });

    it('a sub-agent is never external', () => {
        expect(resolveLane({}, { caller: 'Subagent', isSubagent: true })).toMatchObject({ external: false, shape: BUILD, reach: WORKSPACE });
    });

    it('tolerates a missing behavior', () => {
        expect(resolveLane(null, { caller: 'NewTask' })).toMatchObject({ shape: BUILD, reach: WORKSPACE });
    });
});

describe('appServers', () => {
    it('prefers the explicit list, including an explicit empty one', () => {
        expect(appServers({ mcp_servers: ['jheditor'] }, 'JHEditor')).toEqual(['jheditor']);
        expect(appServers({ mcp_servers: [] }, 'JHEditor')).toEqual([]);
    });

    it('falls back to the caller name lower-cased', () => {
        expect(appServers({}, 'JHEditor')).toEqual(['jheditor']);
        expect(appServers({}, null)).toEqual([]);
    });
});

describe('laneTools', () => {
    const lane = (shape, reach, external = false) => ({ shape, reach, external });

    it('none: web only, no MCP at all', () => {
        const t = laneTools(lane(ASK, NONE, true), { behavior: { mcp_servers: ['backlog'] } });
        expect(t.enabledTools).toEqual([...WEB_TOOLS]);
        expect(t.mcpServerFilter).toEqual([]);
    });

    // The inversion that hid the editor's privacy setting: its MCP tools were
    // filtered out BY NAME while native file tools stayed.
    it('app: web plus the caller\'s own MCP server — and no file tools', () => {
        const t = laneTools(lane(ASK, APP, true), { behavior: { mcp_servers: ['jheditor'] }, caller: 'JHEditor' });
        expect(t.enabledTools).toEqual([...WEB_TOOLS]);
        expect(t.enabledTools).not.toContain('read_file');
        expect(t.mcpServerFilter).toEqual(['jheditor']);
        expect(t.mcpBypassesAllowlist).toBe(true);
    });

    it('app: without a list, only the server matching the caller — never every app', () => {
        const t = laneTools(lane(ASK, APP, true), { behavior: {}, caller: 'JHEditor' });
        expect(t.mcpServerFilter).toEqual(['jheditor']);
    });

    it('workspace ask: the ask allowlist, and selected MCP servers are usable', () => {
        const t = laneTools(lane(ASK, WORKSPACE), { askTools: ['read_file', 'fetch_url'], behavior: { mcp_servers: ['backlog'] } });
        expect(t.enabledTools).toEqual(['read_file', 'fetch_url']);
        expect(t.mcpServerFilter).toEqual(['backlog']);
        expect(t.mcpBypassesAllowlist).toBe(true);
        expect(t.excludeExternalAppMcp).toBe(true);
    });

    it('workspace build: the mode decides, as before', () => {
        expect(laneTools(lane(BUILD, WORKSPACE), { modeTools: null, behavior: { mcp_servers: [] } }))
            .toMatchObject({ enabledTools: null, mcpServerFilter: [], mcpBypassesAllowlist: false });
        expect(laneTools(lane(BUILD, WORKSPACE), { modeTools: ['read_file'] }).enabledTools).toEqual(['read_file']);
    });

    it('an external workspace run is scoped to its own app\'s servers unless it named some', () => {
        expect(laneTools(lane(ASK, WORKSPACE, true), { askTools: [], behavior: {}, caller: 'JHEditor' }).mcpServerFilter).toEqual(['jheditor']);
        expect(laneTools(lane(ASK, WORKSPACE, true), { askTools: [], behavior: {}, caller: 'JHEditor' }).excludeExternalAppMcp).toBe(false);
    });

    it('returns copies, so a caller cannot widen the source lists', () => {
        const ask = ['read_file'];
        const t = laneTools(lane(ASK, WORKSPACE), { askTools: ask });
        t.enabledTools.push('run_command');
        expect(ask).toEqual(['read_file']);
    });
});

describe('small helpers', () => {
    it('only a workspace lane reads project context', () => {
        expect(usesProjectContext({ reach: WORKSPACE })).toBe(true);
        expect(usesProjectContext({ reach: APP })).toBe(false);
        expect(usesProjectContext({ reach: NONE })).toBe(false);
        expect(usesProjectContext(null)).toBe(false);
    });

    it('labels a lane for logs', () => {
        expect(laneLabel({ shape: ASK, reach: APP })).toBe('ask × app');
    });

    it('caps a conversation well below a work run', () => {
        expect(ASK_MAX_STEPS).toBeGreaterThan(3);
        expect(ASK_MAX_STEPS).toBeLessThanOrEqual(20);
    });
});
