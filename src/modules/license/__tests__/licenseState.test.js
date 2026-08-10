// licenseState — expiry, grace, and the promise that we never lock the app.
import { describe as suite, it, expect } from 'vitest';
import {
    GRACE_DAYS, parseDate, effectiveNow, evaluateLicense,
    describeLicense, isEntitled, advanceLastSeen, isKnownEdition,
} from '../licenseState.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 9);           // 2026-08-09
const day = (offset) => NOW + offset * DAY;
/** A verified licence expiring `offset` days from NOW. */
const pro = (offset, extra = {}) => ({
    license: {
        edition: 'pro', licensee: '株式会社テスト',
        expires: new Date(day(offset)).toISOString().slice(0, 10),
        ...extra,
    },
    verified: true,
    now: NOW,
});

suite('parseDate', () => {
    it('reads a date-only key as UTC midnight', () => {
        // Otherwise a licence expires an afternoon early in Tokyo and late in São Paulo.
        expect(parseDate('2026-08-09')).toBe(Date.UTC(2026, 7, 9));
    });

    it('accepts a full ISO timestamp', () => {
        expect(parseDate('2026-08-09T12:00:00Z')).toBe(Date.UTC(2026, 7, 9, 12));
    });

    it('returns null for nothing or nonsense', () => {
        for (const v of ['', null, undefined, 'soon', '2026-13-45x']) {
            expect(parseDate(v)).toBeNull();
        }
    });
});

suite('effectiveNow', () => {
    it('uses the clock when it is moving forward', () => {
        expect(effectiveNow(NOW, NOW - DAY)).toBe(NOW);
    });

    it('distrusts a clock set backwards', () => {
        // The only offline defence available, and a weak one on purpose — see the
        // module comment. It catches the obvious case.
        expect(effectiveNow(NOW - 400 * DAY, NOW)).toBe(NOW);
    });

    it('copes with no history', () => {
        expect(effectiveNow(NOW, 0)).toBe(NOW);
        expect(effectiveNow(NOW)).toBe(NOW);
    });
});

suite('evaluateLicense', () => {
    it('is Community with no key', () => {
        const s = evaluateLicense({});
        expect(s.edition).toBe('community');
        expect(s.status).toBe('none');
        expect(isEntitled(s)).toBe(false);
    });

    it('says so when a key does not verify, rather than silently downgrading', () => {
        // A customer who paid must not be told nothing while quietly losing features.
        const s = evaluateLicense({ license: { edition: 'pro' }, verified: false });
        expect(s.status).toBe('invalid');
        expect(s.edition).toBe('community');
    });

    it('honours a verified licence inside its term', () => {
        const s = evaluateLicense(pro(200));
        expect(s.edition).toBe('pro');
        expect(s.status).toBe('active');
        expect(s.daysLeft).toBe(200);
        expect(s.warn).toBe(false);
        expect(isEntitled(s)).toBe(true);
    });

    it('warns before the term ends instead of surprising on the day', () => {
        const s = evaluateLicense(pro(5));
        expect(s.status).toBe('active');
        expect(s.warn).toBe(true);
    });

    it('is still valid on the final day', () => {
        const s = evaluateLicense(pro(0));
        expect(s.status).toBe('active');
        expect(s.daysLeft).toBe(0);
    });

    it('keeps paid features working through the grace period', () => {
        // A renewal delayed by an invoice cycle is not piracy.
        const s = evaluateLicense(pro(-3));
        expect(s.status).toBe('grace');
        expect(s.edition).toBe('pro');
        expect(isEntitled(s)).toBe(true);
        expect(s.warn).toBe(true);
    });

    it('grants exactly GRACE_DAYS of grace', () => {
        expect(evaluateLicense(pro(-GRACE_DAYS)).status).toBe('grace');
        expect(evaluateLicense(pro(-GRACE_DAYS - 1)).status).toBe('expired');
    });

    it('degrades rather than locks once expired', () => {
        const s = evaluateLicense(pro(-90));
        expect(s.status).toBe('expired');
        expect(s.edition).toBe('community');   // still usable, just not paid
        expect(isEntitled(s)).toBe(false);
        // The licensee is retained so Settings can still show whose licence lapsed.
        expect(s.licensee).toBe('株式会社テスト');
    });

    it('treats a missing expiry as perpetual', () => {
        // A perpetual licence is a legitimate thing to sell; an absent field must not
        // read as "expired in 1970".
        const s = evaluateLicense({
            license: { edition: 'pro', expires: '' }, verified: true, now: NOW,
        });
        expect(s.status).toBe('active');
        expect(s.daysLeft).toBeNull();
        expect(s.warn).toBe(false);
    });

    it('does not promote an edition it has never heard of', () => {
        const s = evaluateLicense({
            license: { edition: 'ultimate', expires: '2099-01-01' }, verified: true, now: NOW,
        });
        expect(s.edition).toBe('community');
    });

    it('applies the clock guard to expiry', () => {
        // Key expired last month; clock rolled back a year. The remembered date wins.
        const s = evaluateLicense({
            license: { edition: 'pro', expires: '2026-07-01' },
            verified: true,
            now: Date.UTC(2025, 7, 9),
            lastSeen: NOW,
        });
        expect(s.status).toBe('expired');
    });
});

suite('describeLicense', () => {
    it('never suggests the app has stopped working', () => {
        for (const state of [
            evaluateLicense(pro(-90)), evaluateLicense(pro(-3)),
            evaluateLicense({ license: { edition: 'pro' }, verified: false }),
        ]) {
            const v = describeLicense(state);
            expect(v.title).toBeTruthy();
            expect(v.detail).toBeTruthy();
        }
    });

    it('tells an expired user their data is still theirs', () => {
        const v = describeLicense(evaluateLicense(pro(-90)));
        expect(v.detail).toContain('Community');
        expect(v.detail).toContain('開けます');
        expect(v.tone).toBe('warn');
    });

    it('counts the remaining grace days', () => {
        const v = describeLicense(evaluateLicense(pro(-4)));
        expect(v.detail).toContain(String(GRACE_DAYS - 4));
    });

    it('is quiet for a healthy licence', () => {
        expect(describeLicense(evaluateLicense(pro(300))).tone).toBe('ok');
    });

    it('marks an unverifiable key as an error, not a warning', () => {
        const v = describeLicense(evaluateLicense({ license: {}, verified: false }));
        expect(v.tone).toBe('error');
    });

    it('handles being called with nothing', () => {
        expect(describeLicense(null).title).toContain('Community');
        expect(describeLicense(undefined).tone).toBe('ok');
    });
});

suite('advanceLastSeen', () => {
    it('only ever moves forward', () => {
        expect(advanceLastSeen(NOW, NOW - DAY)).toBe(NOW);
        expect(advanceLastSeen(NOW - DAY, NOW)).toBe(NOW);
        expect(advanceLastSeen(0, NOW)).toBe(NOW);
        expect(advanceLastSeen(null, null)).toBe(0);
    });
});

suite('isKnownEdition', () => {
    it('recognises the shipped tiers only', () => {
        expect(isKnownEdition('pro')).toBe(true);
        expect(isKnownEdition('ultimate')).toBe(false);
    });
});
