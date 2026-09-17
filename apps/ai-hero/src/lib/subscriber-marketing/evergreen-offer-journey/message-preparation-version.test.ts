import { expect, it } from 'vitest'
import {
	EVERGREEN_OFFER_JOURNEY_V1 as V1,
	EVERGREEN_OFFER_JOURNEY_V2 as V2,
	EVERGREEN_OFFER_JOURNEY_V3 as V3,
	fridayDefinitionError,
} from './definition'
import { calendarFlow, calendarCommit } from './calendar-version.fixtures'
import {
	encodeEvergreenOfferJourneySnapshot,
	restoreEvergreenOfferJourneySnapshot,
} from './restoration'
it('pins V3 approved source, without mutating either historical definition', () => {
	expect(V3.definitionVersion).toBe('evergreen-offer-v3')
	expect(V3.messagePlanSourceHash).toBe(
		'f4fe18461ea2f0e6a1c0a803fb6ac0bda2bb59eceaa19151da99cfea6d7a412e',
	)
	expect(V3.contentRevision).toBe('e2dcb9f52edab599f195e6f05cd7b1b93e25ce3f')
	expect(V3.bridge).toEqual(V2.bridge)
	expect(V3.bridge).not.toBe(V2.bridge)
	expect(V1.definitionVersion).toBe('evergreen-offer-v1')
	expect(V2.definitionVersion).toBe('evergreen-offer-v2')
	expect(
		fridayDefinitionError({ ...V2, definitionVersion: 'evergreen-offer-v3' }),
	).not.toBeNull()
	expect(fridayDefinitionError(V3)).toBeNull()
})
it('V3 is Friday with exactly the V2 slots and expiry, never legacy Thursday', () => {
	const f = calendarFlow(V3),
		old = calendarFlow(V2)
	expect(f.wake.dueAt).toBe('2026-09-11T16:00:00.000Z')
	expect(f.pitch.decision.next.messagePlan.pitch.map((s) => s.dueAt)).toEqual(
		old.pitch.decision.next.messagePlan.pitch.map((s) => s.dueAt),
	)
	expect(f.issued.coupon.expiresAt).toBe(old.issued.coupon.expiresAt)
	for (const step of [f.entry, f.pending, f.pitch, f.terminal])
		expect(
			restoreEvergreenOfferJourneySnapshot(
				encodeEvergreenOfferJourneySnapshot(step.decision.next),
			),
		).toEqual({ ok: true, value: step.decision.next })
})
it.each([V1, V2])(
	'V3 caller does not rewrite historical $definitionVersion',
	(definition) => {
		const f = calendarFlow(definition)
		expect(
			calendarCommit(
				f.entry.decision.next,
				f.pending.stimulus,
				f.pending.decidedAt,
				V3,
			).decision,
		).toEqual(f.pending.decision)
	},
)
