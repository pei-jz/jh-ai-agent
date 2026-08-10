// @vitest-environment jsdom
// UpdateBanner — the guarantee is that nothing installs without a click.
import { describe as suite, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import UpdateBanner from '../UpdateBanner.svelte';

afterEach(cleanup);

suite('UpdateBanner', () => {
    it('shows nothing when idle', () => {
        render(UpdateBanner, { props: { state: { phase: 'idle' } } });
        expect(document.querySelector('.upd-banner')).toBeNull();
    });

    it('installs only when the button is clicked', () => {
        const onInstall = vi.fn();
        render(UpdateBanner, {
            props: { state: { phase: 'available', version: '2.0.0', notes: '' }, onInstall },
        });
        // Rendering an available update must not start a download by itself.
        expect(onInstall).not.toHaveBeenCalled();

        screen.getByText('更新する').click();
        expect(onInstall).toHaveBeenCalledTimes(1);
    });

    it('offers no install button unless an update is actually available', () => {
        for (const phase of ['checking', 'current', 'failed', 'unconfigured', 'downloading']) {
            cleanup();
            render(UpdateBanner, { props: { state: { phase, progress: 0 } } });
            expect(screen.queryByText('更新する')).toBeNull();
        }
    });

    it('names the version and shows the notes', () => {
        render(UpdateBanner, {
            props: { state: { phase: 'available', version: '2.0.0', notes: 'Faster startup' } },
        });
        expect(document.body.textContent).toContain('2.0.0');
        expect(document.body.textContent).toContain('Faster startup');
    });

    it('does not read as up to date when the check failed', () => {
        render(UpdateBanner, { props: { state: { phase: 'failed', error: 'offline' } } });
        expect(document.body.textContent).not.toContain('最新版');
        expect(document.querySelector('.upd-banner.is-failed')).toBeTruthy();
    });

    it('cannot be dismissed mid-download', () => {
        render(UpdateBanner, { props: { state: { phase: 'downloading', progress: 30 } } });
        expect(document.querySelector('.upd-close')).toBeNull();
        expect(document.querySelector('.upd-bar > div').getAttribute('style')).toContain('30%');
    });

    it('cannot be dismissed once the download is ready to apply', () => {
        render(UpdateBanner, { props: { state: { phase: 'ready', version: '2.0.0', progress: 100 } } });
        expect(document.querySelector('.upd-close')).toBeNull();
    });

    it('lets the user dismiss or opt out of an available update', () => {
        const onDismiss = vi.fn();
        const onDisable = vi.fn();
        render(UpdateBanner, {
            props: { state: { phase: 'available', version: '2.0.0' }, onDismiss, onDisable },
        });

        screen.getByText('今後確認しない').click();
        expect(onDisable).toHaveBeenCalledTimes(1);

        document.querySelector('.upd-close').click();
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('offers the opt-out only alongside an actual update', () => {
        // On a failure the choice would read as "stop telling me about errors", which
        // is not what the flag means.
        render(UpdateBanner, { props: { state: { phase: 'failed', error: 'offline' } } });
        expect(screen.queryByText('今後確認しない')).toBeNull();
    });

    it('announces itself politely to screen readers', () => {
        render(UpdateBanner, { props: { state: { phase: 'available', version: '2.0.0' } } });
        const banner = document.querySelector('.upd-banner');
        expect(banner.getAttribute('role')).toBe('status');
        expect(banner.getAttribute('aria-live')).toBe('polite');
    });
});
