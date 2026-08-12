// editions — the paid boundary, and the things that must never be behind it.
import { describe as suite, it, expect } from 'vitest';
import {
    EDITIONS, ENFORCEMENT_ENABLED, FEATURE_MINIMUM, NEVER_GATED,
    editionRank, atLeast, hasFeature, featureAllowed, featuresOf, editionLabel,
} from '../editions.js';

suite('editionRank / atLeast', () => {
    it('orders the tiers', () => {
        expect(editionRank('community')).toBeLessThan(editionRank('pro'));
        expect(editionRank('pro')).toBeLessThan(editionRank('enterprise'));
    });

    it('is case-insensitive about what the key says', () => {
        expect(editionRank('PRO')).toBe(editionRank('pro'));
    });

    it('ranks an unknown edition below everything', () => {
        // A key minted by a newer issuer must not be assumed to be MORE capable.
        expect(editionRank('ultimate')).toBe(-1);
        expect(atLeast('ultimate', 'pro')).toBe(false);
    });

    it('gates nothing on an unknown requirement', () => {
        expect(atLeast('community', 'nonsense-tier')).toBe(true);
    });

    it('counts an edition as at least itself', () => {
        for (const e of EDITIONS) expect(atLeast(e, e)).toBe(true);
    });

    it('lets a higher tier satisfy a lower requirement', () => {
        expect(atLeast('enterprise', 'pro')).toBe(true);
        expect(atLeast('pro', 'enterprise')).toBe(false);
    });
});

suite('the paid boundary', () => {
    it('never gates safety machinery or the user\'s own data', () => {
        // This is the assertion the whole file exists for. If someone adds one of
        // these to FEATURE_MINIMUM, that is a product defect, not a pricing change.
        for (const feature of NEVER_GATED) {
            expect(FEATURE_MINIMUM[feature]).toBeUndefined();
            expect(hasFeature('community', feature)).toBe(true);
        }
    });

    it('only names editions that exist', () => {
        for (const [feature, tier] of Object.entries(FEATURE_MINIMUM)) {
            expect(EDITIONS, `${feature} requires unknown tier ${tier}`).toContain(tier);
        }
    });

    it('never makes the free tier the requirement', () => {
        // "Requires community" means "free", so listing it is a mistake that reads
        // as a restriction.
        for (const tier of Object.values(FEATURE_MINIMUM)) {
            expect(tier).not.toBe('community');
        }
    });
});

suite('hasFeature', () => {
    it('is permissive while enforcement is switched off', () => {
        // Documents today's shipped behaviour: the mechanism exists, the gate is open.
        expect(ENFORCEMENT_ENABLED).toBe(false);
        expect(hasFeature('community', 'office_write')).toBe(true);
        expect(hasFeature('community', 'audit_export')).toBe(true);
    });

    it('fails open for an unlisted feature', () => {
        // Forgetting a table entry must never accidentally lock something.
        expect(hasFeature('community', 'some_new_thing')).toBe(true);
    });
});

suite('featureAllowed — what enforcement WOULD do', () => {
    // Tested separately from hasFeature so flipping ENFORCEMENT_ENABLED is not the
    // first time these rules ever execute.
    it('closes paid features to the free tier', () => {
        expect(featureAllowed('community', 'office_write')).toBe(false);
        expect(featureAllowed('community', 'scheduled_tasks')).toBe(false);
        expect(featureAllowed('community', 'audit_export')).toBe(false);
    });

    it('opens Pro features to Pro and above', () => {
        expect(featureAllowed('pro', 'office_write')).toBe(true);
        expect(featureAllowed('enterprise', 'office_write')).toBe(true);
    });

    it('keeps Enterprise features out of Pro', () => {
        expect(featureAllowed('pro', 'audit_export')).toBe(false);
        expect(featureAllowed('enterprise', 'audit_export')).toBe(true);
    });

    it('still fails open for an unlisted feature', () => {
        expect(featureAllowed('community', 'not_in_the_table')).toBe(true);
    });

    it('never closes anything on the never-gated list', () => {
        for (const feature of NEVER_GATED) {
            expect(featureAllowed('community', feature), feature).toBe(true);
        }
    });

    it('treats an unrecognised edition as the free tier', () => {
        expect(featureAllowed('ultimate', 'office_write')).toBe(false);
        expect(featureAllowed('', 'office_write')).toBe(false);
    });
});

suite('featuresOf', () => {
    it('gives the free tier no paid extras', () => {
        expect(featuresOf('community')).toEqual([]);
    });

    it('grows with the tier', () => {
        const pro = featuresOf('pro');
        const ent = featuresOf('enterprise');
        expect(pro.length).toBeGreaterThan(0);
        // Enterprise is a superset — a paying customer never loses a feature by
        // upgrading.
        for (const f of pro) expect(ent).toContain(f);
        expect(ent.length).toBeGreaterThan(pro.length);
    });
});

suite('editionLabel', () => {
    const cases = [
        ['pro', 'Pro'], ['PRO', 'Pro'],
        ['enterprise', 'Enterprise'],
        ['community', 'Community'],
        // Anything we do not recognise reads as the free tier rather than as blank
        // or as the raw string.
        ['', 'Community'], [null, 'Community'], ['ultimate', 'Community'],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)} -> ${expected}`, () => {
            expect(editionLabel(input)).toBe(expected);
        });
    }
});
