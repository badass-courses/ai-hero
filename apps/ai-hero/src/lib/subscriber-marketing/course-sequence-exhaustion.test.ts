import { describe, expect, it } from 'vitest'
import { courseSequenceContactEvent } from '@/db/course-sequence-exhaustion-schema'
import { contactEvent } from '@/db/schema'

import { courseSequenceExhaustedStimulusFromContactEvent } from './evergreen-offer-journey/course-sequence-exhausted-adapter'
import {
	COURSE_DEADLINE_FALLBACK_TIME_ZONE,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
	deadlineTimeZoneEvidenceFromHeader,
	AIH_COURSE_ENTRY_EVIDENCE_FIELD,
	parseCourseSequenceExhaustionEnabled,
	parseStashedDeadlineTimeZoneEvidence,
	readCoursePayload,
	restoreCourseSequenceExhaustedPayload,
	restoreDeadlineTimeZoneEvidence,
	serializeDeadlineTimeZoneEvidenceForKit,
	withCoursePayload,
} from './course-sequence-exhaustion'

const capturedAt = '2026-08-30T02:00:00.000Z'

function validPayload() {
	return {
		format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
		actor: {
			actorId: 'email-course:contact-1:ai-hero-skills-workflow',
			contactId: 'contact-1',
			valuePathId: 'ai-hero-skills-workflow',
			courseEntryEventId: 'entry-event-1',
		},
		exhaustedAt: '2026-09-04T17:00:00.000Z',
		deadlineTimeZone: {
			type: 'BrowserEntryHeader',
			headerName: 'x-vercel-ip-timezone',
			timeZone: 'Asia/Tokyo',
			capturedAt,
		},
		progression: {
			from: {
				intentId: 'email-6-intent',
				idempotencyKey:
					'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-6',
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				completedAt: '2026-09-03T12:00:00.000Z',
			},
			trigger: {
				type: 'DailyDripDue',
				evaluatedAt: '2026-09-04T17:00:00.000Z',
				reason: 'local-day-9am-due',
			},
			terminal: {
				intentId: 'email-7-intent',
				idempotencyKey:
					'contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-7',
				nextActionId: 'next-action-7',
				emailResourceId: 'ai-hero-skills-workflow.email-7',
			},
		},
		sourceReferences: {
			courseEntryEventId: 'entry-event-1',
			priorIntentId: 'email-6-intent',
		},
	}
}

describe('course sequence exhaustion evidence', () => {
	it('preserves an exact validated browser header', () => {
		expect(
			deadlineTimeZoneEvidenceFromHeader({
				headerValue: 'Asia/Tokyo',
				capturedAt,
			}),
		).toEqual({
			ok: true,
			value: {
				type: 'BrowserEntryHeader',
				headerName: 'x-vercel-ip-timezone',
				timeZone: 'Asia/Tokyo',
				capturedAt,
			},
		})
	})

	it.each([
		[undefined, 'header-missing'],
		['not-a-time-zone', 'header-invalid'],
	] as const)(
		'records %s as explicit Pacific fallback',
		(headerValue, reason) => {
			expect(
				deadlineTimeZoneEvidenceFromHeader({ headerValue, capturedAt }),
			).toEqual({
				ok: true,
				value: {
					type: 'ExplicitFallback',
					reason,
					timeZone: COURSE_DEADLINE_FALLBACK_TIME_ZONE,
					capturedAt,
				},
			})
		},
	)

	it('marks pre-evidence learners as legacy fallback', () => {
		expect(
			deadlineTimeZoneEvidenceFromHeader({
				headerValue: undefined,
				capturedAt,
				existingLearner: true,
			}),
		).toMatchObject({
			ok: true,
			value: {
				type: 'ExplicitFallback',
				reason: 'legacy-entry',
				timeZone: COURSE_DEADLINE_FALLBACK_TIME_ZONE,
			},
		})
	})

	it('round-trips evidence through the bounded Kit confirmation stash', () => {
		const evidence = deadlineTimeZoneEvidenceFromHeader({
			headerValue: 'Europe/London',
			capturedAt,
		})
		if (!evidence.ok) throw new Error(evidence.error.detail)
		const serialized = serializeDeadlineTimeZoneEvidenceForKit(evidence.value)

		expect(
			parseStashedDeadlineTimeZoneEvidence({
				[AIH_COURSE_ENTRY_EVIDENCE_FIELD]: serialized,
			}),
		).toEqual(evidence.value)
	})

	it('rejects fallback evidence that smuggles another zone', () => {
		expect(
			restoreDeadlineTimeZoneEvidence({
				type: 'ExplicitFallback',
				reason: 'header-missing',
				timeZone: 'Europe/London',
				capturedAt,
			}),
		).toBeUndefined()
	})

	it('round-trips the versioned terminal progression payload', () => {
		expect(restoreCourseSequenceExhaustedPayload(validPayload())).toEqual(
			validPayload(),
		)
	})

	it.each([
		[
			'Email 5 source',
			{
				progression: {
					...validPayload().progression,
					from: {
						...validPayload().progression.from,
						emailResourceId: 'ai-hero-skills-workflow.email-5',
					},
				},
			},
		],
		[
			'Email 6 terminal',
			{
				progression: {
					...validPayload().progression,
					terminal: {
						...validPayload().progression.terminal,
						emailResourceId: 'ai-hero-skills-workflow.email-6',
					},
				},
			},
		],
		[
			'wrong actor',
			{
				actor: {
					...validPayload().actor,
					actorId: 'email-course:somebody-else:ai-hero-skills-workflow',
				},
			},
		],
	] as const)('rejects %s', (_label, patch) => {
		expect(
			restoreCourseSequenceExhaustedPayload({ ...validPayload(), ...patch }),
		).toBeUndefined()
	})

	it('maps the owned Contact Event into the downstream journey stimulus', () => {
		const event = {
			id: 'sequence-fact-1',
			contactId: 'contact-1',
			providerIdentityId: 'identity-1',
			provider: 'ai-hero' as const,
			providerEventId: 'sequence-fact-1',
			providerReference: 'value-path:ai-hero-skills-workflow',
			eventType: 'course.sequence-exhausted',
			occurredAt: '2026-09-04T17:00:00.000Z',
			semanticIdempotencyKey:
				'email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow',
			domainFactKey:
				'email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow',
			payloadFormat: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
			domainPayload: validPayload(),
			privacyLevel: 'internal' as const,
			identityEvidence: {
				source: 'ai-hero' as const,
				strength: 'strong' as const,
			},
			payloadSummary: {
				summary: 'Sequence exhausted',
				keywords: ['sequence-exhausted'],
				restrictedPayloadStored: false as const,
			},
			schemaVersion: 1 as const,
			createdAt: '2026-09-04T17:00:00.000Z',
		}

		expect(courseSequenceExhaustedStimulusFromContactEvent(event)).toEqual({
			ok: true,
			value: {
				type: 'CourseSequenceExhausted',
				stimulusId: 'sequence-fact-1',
				entryFactId: 'sequence-fact-1',
				contactId: 'contact-1',
				valuePathId: 'ai-hero-skills-workflow',
				exhaustedAt: '2026-09-04T17:00:00.000Z',
				deadlineTimeZone: validPayload().deadlineTimeZone,
				sourceReference: 'side-effect-intent:email-6-intent',
			},
		})
	})

	it('stores typed course payloads inside the existing summary JSON', () => {
		const payload = restoreCourseSequenceExhaustedPayload(validPayload())
		if (!payload) throw new Error('Expected valid sequence-exhausted payload')
		const payloadSummary = withCoursePayload(
			{
				summary: 'Course sequence exhausted',
				keywords: ['course', 'sequence-exhausted'],
				restrictedPayloadStored: false,
			},
			COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
			payload,
		)

		expect(readCoursePayload(payloadSummary)).toEqual({
			format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
			payload,
		})
		expect(readCoursePayload({ coursePayload: { format: '' } })).toBeUndefined()
	})

	it('uses one deterministic fact key per contact and value path', () => {
		expect(
			courseSequenceExhaustionFactKey({
				contactId: 'contact-1',
				valuePathId: 'ai-hero-skills-workflow',
			}),
		).toBe('email-course.sequence-exhausted:contact-1:ai-hero-skills-workflow')
	})

	it('reuses the always-on Contact Event schema without parallel fact columns', () => {
		expect(courseSequenceContactEvent).toBe(contactEvent)
		expect('domainFactKey' in courseSequenceContactEvent).toBe(false)
		expect('domainPayload' in courseSequenceContactEvent).toBe(false)
	})

	it('keeps activation disabled unless the exact true value is present', () => {
		expect(parseCourseSequenceExhaustionEnabled(undefined)).toBe(false)
		expect(parseCourseSequenceExhaustionEnabled('false')).toBe(false)
		expect(parseCourseSequenceExhaustionEnabled('true')).toBe(true)
	})
})
