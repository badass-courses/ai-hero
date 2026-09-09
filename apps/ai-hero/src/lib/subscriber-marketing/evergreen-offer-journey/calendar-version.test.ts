import { expect, it } from 'vitest'
import {
	EVERGREEN_OFFER_JOURNEY_V1 as V1,
	EVERGREEN_OFFER_JOURNEY_V2 as V2,
	fridayDefinitionError,
} from './definition'
import {
	calendarFlow,
	calendarCommit,
	calendarInstant,
	calendarEntry,
} from './calendar-version.fixtures'
import {
	encodeEvergreenOfferJourneySnapshot,
	restoreEvergreenOfferJourneySnapshot,
} from './restoration'
import { decideEvergreenOfferJourney } from './decision'

it('pins actual V2 content independently and retains known resource and selected IDs', () => {
	expect(V2).toEqual({
		...V1,
		definitionVersion: 'evergreen-offer-v2',
		messagePlanId: 'crash_course_evergreen_presentation_v2',
		messagePlanSourceHash:
			'012196f2e8ff4badd599649b503ecfcb8053c28888ffdb4f0ca16b5e710298b5',
		contentRevision: '1d938eef6d7c17edda218ed3a7922f6ba15c8ec9',
		presentationReviewRevision: '9d92b3c836a2085676ffb258294fa1f891661167',
	})
	expect(V1.messagePlanSourceHash).toBe(
		'7097327f4c1a175a91835f838ac629694e38e8bb40b3817b2e831f4d1a029b4b',
	)
	expect(V2.bridge).not.toBe(V1.bridge)
	expect(
		fridayDefinitionError({ ...V1, definitionVersion: V2.definitionVersion }),
	).not.toBeNull()
})

it('keeps bridge while changing only the pinned new-entry pitch calendar', () => {
	const old = calendarFlow(V1)
	const next = calendarFlow(V2)
	expect(
		next.entry.decision.next.messagePlan.bridge.map((slot) => slot.dueAt),
	).toEqual(
		old.entry.decision.next.messagePlan.bridge.map((slot) => slot.dueAt),
	)
	expect(
		next.pending.decision.next.messagePlan.bridge.map((slot) => slot.status),
	).toEqual(['Missed', 'Missed', 'Missed'])
	expect(next.wake.dueAt).toBe('2026-09-11T16:00:00.000Z')
	expect(old.wake.dueAt).toBe('2026-09-10T16:00:00.000Z')
	expect(
		next.pitch.decision.next.messagePlan.pitch.map((slot) => slot.dueAt),
	).toEqual([
		'2026-09-11T16:00:00.000Z',
		'2026-09-12T16:00:00.000Z',
		'2026-09-14T16:00:00.000Z',
		'2026-09-15T16:00:00.000Z',
		'2026-09-16T03:00:00.000Z',
	])
	expect(next.issued.coupon.expiresAt).toBe('2026-09-16T06:59:59.000Z')
	const schedule = [
		...next.pitch.decision.next.messagePlan.pitch.map((slot) => slot.dueAt),
		next.issued.coupon.expiresAt,
	]
	expect(
		schedule.every((at, index) => !index || at > schedule[index - 1]!),
	).toBe(true)
})

it.each([V1, V2, { ...V1, definitionVersion: 'historical-free-string' }])(
	'roundtrips pending, pitch and terminal history for $definitionVersion',
	(definition) => {
		const flow = calendarFlow(definition)
		for (const step of [flow.entry, flow.pending, flow.pitch, flow.terminal]) {
			const encoded = encodeEvergreenOfferJourneySnapshot(step.decision.next)
			const restored = restoreEvergreenOfferJourneySnapshot(encoded)
			expect(restored).toEqual({ ok: true, value: step.decision.next })
		}
	},
)

it('resumes V1 with V2 caller without changing its window, metadata or pitch', () => {
	const flow = calendarFlow(V1)
	const resumed = calendarCommit(
		flow.entry.decision.next,
		flow.pending.stimulus,
		flow.pending.decidedAt,
		V2,
	)
	expect(resumed.decision).toEqual(flow.pending.decision)
	const pitched = calendarCommit(
		resumed.decision.next,
		flow.issued,
		flow.pitch.decidedAt,
		V2,
	)
	expect(pitched.decision).toEqual(flow.pitch.decision)
})

it.each([
	[V1, V2],
	[V2, V1],
])('rejects dates from another policy', (target, other) => {
	const flow = calendarFlow(target)
	const wrong = calendarFlow(other)
	const response = decideEvergreenOfferJourney({
		snapshot: flow.pending.decision.next,
		stimulus: wrong.issued,
		currentFacts: flow.pitch.currentFacts,
		definition: target,
		now: flow.pitch.decidedAt,
	})
	expect(response.ok).toBe(false)
	const mixed = {
		...flow.pitch.decision.next,
		messagePlan: {
			...flow.pitch.decision.next.messagePlan,
			pitch: wrong.pitch.decision.next.messagePlan.pitch,
		},
	}
	expect(
		restoreEvergreenOfferJourneySnapshot(
			encodeEvergreenOfferJourneySnapshot(mixed),
		).ok,
	).toBe(false)
})

it('late receipt preserves original expiry and rejects an extended coupon', () => {
	const flow = calendarFlow(V2)
	const lateAt = calendarInstant('2026-09-14T16:00:00.000Z')
	const late = calendarCommit(
		flow.pending.decision.next,
		flow.issued,
		lateAt,
		V2,
	)
	expect(late.decision.next.coupon?.expiresAt).toBe(
		flow.issued.coupon.expiresAt,
	)
	const extended = decideEvergreenOfferJourney({
		snapshot: flow.pending.decision.next,
		stimulus: {
			...flow.issued,
			coupon: {
				...flow.issued.coupon,
				expiresAt: calendarInstant('2026-09-17T06:59:59.000Z'),
			},
		},
		currentFacts: { ...flow.pitch.currentFacts, readAt: lateAt },
		definition: V2,
		now: lateAt,
	})
	expect(extended.ok).toBe(false)
})

it('rejects V2 entry and restoration with legacy content binding', () => {
	const entry = calendarEntry(V2)
	expect(
		decideEvergreenOfferJourney({
			snapshot: null,
			stimulus: entry.stimulus,
			currentFacts: entry.currentFacts,
			definition: { ...V1, definitionVersion: V2.definitionVersion },
			now: entry.decidedAt,
		}).ok,
	).toBe(false)
	const bad = {
		...entry.decision.next,
		definition: { ...V1, definitionVersion: V2.definitionVersion },
	}
	expect(
		restoreEvergreenOfferJourneySnapshot(
			encodeEvergreenOfferJourneySnapshot(bad),
		).ok,
	).toBe(false)
})
