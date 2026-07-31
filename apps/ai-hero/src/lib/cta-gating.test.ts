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
	// The two waitlists on the offer ladder are the same word and different
	// things: one is a cohort that already ran and will run again, the other is
	// a workshop still in draft that has never shipped. They are stored under
	// different Kit fields keyed off different identifiers, so signing up for
	// one must never satisfy the other — otherwise joining the cohort waitlist
	// would silently suppress the announcement of a brand new course.
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
	const workshopOffer = {
		kind: 'workshop' as const,
		slug: 'ai-coding-crash-course',
	}

	it('recognises each waitlist on its own terms', () => {
		expect(hasJoinedOfferWaitlist(cohortWaiter, cohortOffer)).toBe(true)
		expect(hasJoinedOfferWaitlist(workshopWaiter, workshopOffer)).toBe(true)
	})

	it('does not let one waitlist stand in for the other', () => {
		expect(hasJoinedOfferWaitlist(cohortWaiter, workshopOffer)).toBe(false)
		expect(hasJoinedOfferWaitlist(workshopWaiter, cohortOffer)).toBe(false)
	})

	it('never suppresses an offer that has no waitlist to join', () => {
		// A sale or a purchasable cohort is answered by owning it, not by
		// signing up — so this must not be the thing that hides it.
		expect(hasJoinedOfferWaitlist(cohortWaiter, undefined)).toBe(false)
	})
})

describe('hasWorkshopInterest', () => {
	it('normalizes the slug the same way the capture does', () => {
		expect(
			hasWorkshopInterest(
				subscriber({ fields: { interest_mcp_fundamentals: '2026-07-14' } }),
				'mcp-fundamentals',
			),
		).toBe(true)
	})

	it('is false when interest was never expressed', () => {
		expect(hasWorkshopInterest(subscriber(), 'mcp-fundamentals')).toBe(false)
	})
})
