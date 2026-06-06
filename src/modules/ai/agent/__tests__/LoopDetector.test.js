import { describe, it, expect } from 'vitest';
import { detectCycle } from '../LoopDetector.js';

const call = (name, args = '') => ({ name, argsStr: args });

describe('detectCycle', () => {
    it('returns null for non-array or disabled', () => {
        expect(detectCycle(null, 3)).toBeNull();
        expect(detectCycle([], 0)).toBeNull();
        expect(detectCycle([call('a')], -1)).toBeNull();
    });

    it('returns null when no cycle', () => {
        const h = [call('a'), call('b'), call('c'), call('d')];
        expect(detectCycle(h, 2)).toBeNull();
    });

    it('detects a 2-cycle (ABAB…)', () => {
        const h = [call('A'), call('B'), call('A'), call('B')]; // 2*minRepeats=4
        const r = detectCycle(h, 2);
        expect(r).toMatchObject({ length: 2, pattern: 'A→B' });
    });

    it('does NOT treat AAAA as a 2-cycle (needs distinct A,B)', () => {
        const h = [call('A'), call('A'), call('A'), call('A')];
        expect(detectCycle(h, 2)).toBeNull();
    });

    it('distinguishes by args, not just name', () => {
        const h = [call('A', '{"x":1}'), call('A', '{"x":2}'), call('A', '{"x":1}'), call('A', '{"x":2}')];
        const r = detectCycle(h, 2);
        expect(r).toMatchObject({ length: 2 });
    });

    it('detects a 3-cycle (ABCABC…)', () => {
        // 3-cycle needs 3*max(2,minRepeats); with minRepeats=2 → 6 calls
        const h = [call('A'), call('B'), call('C'), call('A'), call('B'), call('C')];
        const r = detectCycle(h, 2);
        expect(r).toMatchObject({ length: 3, pattern: 'A→B→C' });
    });

    it('ignores older history outside the cycle window', () => {
        const h = [call('Z'), call('Y'), call('A'), call('B'), call('A'), call('B')];
        const r = detectCycle(h, 2);
        expect(r).toMatchObject({ length: 2, pattern: 'A→B' });
    });
});
