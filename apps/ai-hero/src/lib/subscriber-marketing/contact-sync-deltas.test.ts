import { describe, expect, it } from 'vitest'
import { contactProfileContentHash } from './drovr-contact-profile-sync'
import {
	linkSendDecision,
	profileVersionBump,
	bulkPaceDecision,
	BULK_EVENTS_PER_MINUTE,
	requireBackfillCanary,
	restatementPlan,
} from './contact-sync-deltas'

const snapshot = {
	profile: { email: 'learner@example.test', firstName: null, holds: [] },
	links: [],
	offers: [],
}

describe('contact sync delta gates', () => {
	it('coupons do not change the profile digest', () => {
		expect(contactProfileContentHash(snapshot)).toBe(
			contactProfileContentHash({
				...snapshot,
				offers: [{ journeyId: 'journey', couponId: 'coupon', variables: {} }],
			}),
		)
	})
	it('checks generated decision inputs against the contract', () => {
		for (let version = 1; version <= 17; version++)
			for (let offset = -35; offset <= 35; offset++) {
				const prev = {
					value: 'a',
					profileVersion: version,
					expiresAt: 10000000000,
				}
				const next = { ...prev, dueAt: prev.expiresAt - offset * 86400000 }
				expect(linkSendDecision(prev, next, 0).action).toBe(
					offset <= 30 ? 'send' : 'skip',
				)
				expect(
					linkSendDecision(prev, { ...next, profileVersion: version + 1 }, 0)
						.action,
				).toBe('send')
				expect(linkSendDecision(prev, { ...next, value: 'b' }, 0).action).toBe(
					'send',
				)
				expect(
					profileVersionBump({
						kind: 'coupon-issued',
						previousHash: 'a',
						nextHash: 'b',
					}),
				).toBe(false)
			}
	})
	it('paces every sliding minute without a burst, across retries', () => {
		expect(BULK_EVENTS_PER_MINUTE).toBeLessThanOrEqual(300)
		let nextAt = 0
		const starts: number[] = []
		for (let now = 0; now < 130000; now += 13) {
			const decision = bulkPaceDecision(nextAt, now)
			if (decision.action === 'send') {
				starts.push(now)
				nextAt = decision.nextAt
			}
		}
		for (const start of starts)
			expect(
				starts.filter((at) => at >= start && at < start + 60000).length,
			).toBeLessThanOrEqual(300)
		expect(starts.every((at, i) => i === 0 || at - starts[i - 1]! >= 200)).toBe(
			true,
		)
	})
	it('sizes a bounded population for coverage within sixty days', () => {
		for (let population = 1; population < 900000; population += 7919) {
			const plan = restatementPlan(
				population,
				Date.parse('2032-02-04T00:00:00Z'),
			)
			expect(
				Math.ceil(population / plan.contacts) * 15 * 60000,
			).toBeLessThanOrEqual(60 * 86400000)
		}
	})
	it('refuses an apply without the canary and the dry-run count', () => {
		expect(() => requireBackfillCanary({})).toThrow('BackfillCanary:')
		expect(() => requireBackfillCanary({ canary: true })).toThrow(
			'BackfillCanary:',
		)
		expect(() =>
			requireBackfillCanary({ canary: true, dryRunCount: 3 }),
		).not.toThrow()
	})
})
