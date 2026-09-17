import type { Subscriber } from '@/schemas/subscriber'
import { describe, expect, it } from 'vitest'

import {
	hasJoinedOfferWaitlist,
	hasStartedFreeCourse,
	hasWorkshopInterest,
	isOnCohortWaitlist,
	isOnEmailList,
} from './cta-gating'

function subscriber(overrides: Partial<Subscriber> = {}): Subscriber {
	return {
		id: 1,
		email_address: 'reader@example.com',
		state: 'active',
		fields: {},
		...overrides,
	}
}

describe('isOnEmailList', () => {
	it('is true only for a confirmed subscriber', () => {
		expect(isOnEmailList(subscriber())).toBe(true)
	})

	it.each(['inactive', 'cancelled', 'bounced'])(
		'still asks a %s subscriber',
		(state) => {
			expect(isOnEmailList(subscriber({ state }))).toBe(false)
		},
	)

	it('treats an unresolved subscriber as not subscribed', () => {
		expect(isOnEmailList(null)).toBe(false)
		expect(isOnEmailList(undefined)).toBe(false)
	})
})

describe('hasStartedFreeCourse', () => {
	it('is true only when learner-flow enrollment wrote its start receipt', () => {
		expect(
			hasStartedFreeCourse(
				subscriber({ fields: { aih_course_started_at: '2026-07-31' } }),
			),
		).toBe(true)
	})

	it('does not mistake the legacy Skills newsletter field for course entry', () => {
		expect(hasStartedFreeCourse(subscriber())).toBe(false)
		expect(
			hasStartedFreeCourse(subscriber({ fields: { interest: 'skills' } })),
		).toBe(false)
	})

	it('is false for an unconfirmed subscriber even with the field set', () => {
		expect(
			hasStartedFreeCourse(
				subscriber({
					state: 'inactive',
					fields: { aih_course_started_at: '2026-07-31' },
				}),
			),
		).toBe(false)
	})
})

describe('isOnCohortWaitlist', () => {
	// The key the cohort pricing widget actually writes, snake-cased from the
	// product name. Pinned literally: deriving it in the test too would let both
	// sides drift together and still pass.
	const productName = 'AI Coding for Real Engineers'
	const fieldKey = 'waitlist_ai_coding_for_real_engineers'

	it('is true when the per-cohort waitlist field carries a join date', () => {
		expect(
			isOnCohortWaitlist(
				subscriber({ fields: { [fieldKey]: '2026-07-14' } }),
				productName,
			),
		).toBe(true)
	})

	it('does not confuse one cohort waitlist for another', () => {
		expect(
			isOnCohortWaitlist(
				subscriber({ fields: { waitlist_some_other_cohort: '2026-07-14' } }),
				productName,
			),
		).toBe(false)
	})

	it.each([null, ''])('treats %p as not on the waitlist', (value) => {
		expect(
			isOnCohortWaitlist(
				subscriber({ fields: { [fieldKey]: value } }),
				productName,
			),
		).toBe(false)
	})

	it('is false without a product name to key on', () => {
		expect(isOnCohortWaitlist(subscriber(), undefined)).toBe(false)
	})
})

describe('hasJoinedOfferWaitlist', () => {
	// The cohort waitlist is keyed off the product NAME under its own Kit
	// field; a workshop interest field for some other course must never stand
	// in for it.
	const cohortWaiter = subscriber({
		fields: { waitlist_ai_coding_for_real_engineers: '2026-07-14' },
	})
	const workshopWaiter = subscriber({
		fields: { interest_ai_coding_crash_course: '2026-07-14' },
	})
	const cohortOffer = {
		kind: 'cohort' as const,
		productName: 'AI Coding for Real Engineers',
	}

	it('recognises the cohort waitlist by its product name', () => {
		expect(hasJoinedOfferWaitlist(cohortWaiter, cohortOffer)).toBe(true)
	})

	it('does not let a workshop interest field stand in for it', () => {
		expect(hasJoinedOfferWaitlist(workshopWaiter, cohortOffer)).toBe(false)
	})

	it('never suppresses an offer that has no waitlist to join', () => {
		// A sale, a purchasable cohort, or a buyable workshop is answered by
		// owning it, not by signing up — so this must not be the thing that
		// hides it.
		expect(hasJoinedOfferWaitlist(cohortWaiter, undefined)).toBe(false)
	})
})
