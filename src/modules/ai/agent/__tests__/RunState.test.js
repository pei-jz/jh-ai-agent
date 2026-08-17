// RunState — the run-scoped facts, out where they can be asserted on.
//
// These lived inside a 1,788-line method, so the only way to check that (say)
// the unlimited-run progress curve never reaches 1.0 was to drive a whole
// scripted run and read a status event.

import { describe, it, expect } from 'vitest';
import { RunState } from '../RunState.js';

describe('step budget', () => {
    it('counts from 1 on the first step', () => {
        const st = new RunState({ maxIterations: 3 });
        expect(st.iteration).toBe(0);
        expect(st.nextIteration()).toBe(1);
    });

    it('runs out after maxIterations', () => {
        const st = new RunState({ maxIterations: 2 });
        expect(st.hasStepsLeft()).toBe(true);
        st.nextIteration();
        expect(st.hasStepsLeft()).toBe(true);
        st.nextIteration();
        expect(st.hasStepsLeft()).toBe(false);
    });

    it('treats 0 and negatives as unlimited', () => {
        for (const n of [0, -1]) {
            const st = new RunState({ maxIterations: n });
            expect(st.isUnlimited).toBe(true);
            st.iteration = 100000;
            expect(st.hasStepsLeft()).toBe(true);
        }
    });
});

describe('progress', () => {
    it('is a plain ratio when bounded', () => {
        const st = new RunState({ maxIterations: 10 });
        st.iteration = 5;
        expect(st.progress()).toBeCloseTo(0.5);
    });

    it('never reaches 1.0 when unlimited', () => {
        // Claiming 100% and then continuing is worse than claiming nothing.
        const st = new RunState({ maxIterations: 0 });
        for (const n of [1, 50, 200, 5000]) {
            st.iteration = n;
            expect(st.progress()).toBeLessThan(1);
            expect(st.progress()).toBeGreaterThan(0);
        }
    });

    it('creeps forward monotonically when unlimited', () => {
        const st = new RunState({ maxIterations: 0 });
        let prev = -1;
        for (const n of [1, 10, 50, 100, 200]) {
            st.iteration = n;
            const p = st.progress();
            expect(p).toBeGreaterThan(prev);
            prev = p;
        }
    });

    it('is 0.5 at step 50 with no ceiling', () => {
        const st = new RunState({ maxIterations: 0 });
        st.iteration = 50;
        expect(st.progress()).toBeCloseTo(0.5);
    });
});

describe('elapsed time', () => {
    it('measures from the injected start', () => {
        const st = new RunState({ startedAt: 1000 });
        expect(st.elapsedMs(61000)).toBe(60000);
    });
});

describe('defaults', () => {
    it('constructs with no arguments', () => {
        const st = new RunState();
        expect(st.isUnlimited).toBe(true);
        expect(st.history).toEqual([]);
        expect(st.iteration).toBe(0);
    });
});
