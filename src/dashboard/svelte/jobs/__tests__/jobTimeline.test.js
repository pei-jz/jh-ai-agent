// @vitest-environment jsdom
//
// The history answers "what ran last night". Its next question is always "let
// me see it" — and every started entry has carried the taskId since the day the
// timeline was written. The row just had nowhere to click, so the transcript
// that explains a 3am run had to be hunted for by hand.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

const { default: JobTimeline } = await import('../JobTimeline.svelte');

afterEach(cleanup);

const ENTRIES = [
    { at: 1757000000000, job: '日報', kind: 'time', outcome: 'started', taskId: 'task_abc' },
    { at: 1757000100000, job: '日報', kind: 'time', outcome: 'skipped', why: 'cooldown' },
];

describe('a run in the history can be opened', () => {
    it('jumps to the task it created', async () => {
        const navigate = vi.fn();
        render(JobTimeline, { props: { entries: ENTRIES, navigate } });
        await fireEvent.click(screen.getByText('開く'));
        expect(navigate).toHaveBeenCalledWith('#monitor?id=task_abc');
    });

    it('offers nothing to open for a run that never happened', () => {
        render(JobTimeline, { props: { entries: ENTRIES, navigate: vi.fn() } });
        // Two rows, one button: a skipped entry has no transcript to show, and
        // a dead button that silently does nothing is worse than no button.
        expect(screen.getAllByText('開く')).toHaveLength(1);
    });
});
