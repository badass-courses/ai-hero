import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
	COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
	readCoursePayload,
	restoreCourseSequenceExhaustedPayload,
} from '../course-sequence-exhaustion'
import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from '../email-course/definition'
import { deriveCourseRunId, parseEventId } from '../email-course/primitives'
import { SKILLS_WORKFLOW_PATH_SLUGS } from '../skills-workflow-path'
import { courseSequenceExhaustedStimulusFromContactEvent } from './course-sequence-exhausted-adapter'
import { decideEvergreenOfferJourney } from './decision'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type {
	CourseSequenceExhausted,
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	EvergreenOfferStimulus,
} from './domain'
import type { JourneyLedgerCommit } from './ports'
import { parseIsoInstant, parseStimulusId } from './primitives'

const provider = z.enum(['fixture', 'front', 'kit', 'ai-hero'])
const identityEvidence = z
	.object({
		source: provider,
		strength: z.enum(['weak', 'medium', 'strong']),
		email: z.string().optional(),
		name: z.string().optional(),
		userId: z.string().optional(),
		providerIdentity: z.object({ provider, externalId: z.string() }).optional(),
	})
	.passthrough()
const sourceRow = z.object({
	id: z.string().min(1),
	contactId: z.string().min(1),
	providerIdentityId: z.string().min(1),
	provider: z.literal('ai-hero'),
	providerEventId: z.string().min(1),
	providerReference: z.string().min(1),
	eventType: z.literal(COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE),
	semanticIdempotencyKey: z.string().min(1),
	schemaVersion: z.literal(1),
	occurredAt: z.date(),
	createdAt: z.date(),
	privacyLevel: z.enum(['public', 'internal', 'restricted']),
	identityEvidence,
	payloadSummary: z
		.object({
			summary: z.string(),
			keywords: z.array(z.string()),
			restrictedPayloadStored: z.literal(false),
		})
		.passthrough(),
})

/** Decode only committed ContactEvent evidence. No fallback, inferred completion,
 * provider membership or invented entry fact. Owning payload codec pins both paths.
 */
export function restoreSourceCandidate(
	input: unknown,
): CourseSequenceExhausted | null {
	const decoded = sourceRow.safeParse(input)
	if (!decoded.success) return null
	const row = decoded.data
	const payload = restoreCourseSequenceExhaustedPayload(
		readCoursePayload(row.payloadSummary)?.payload,
	)
	if (
		!payload ||
		Math.floor(Date.parse(payload.exhaustedAt) / 1000) !==
			Math.floor(row.occurredAt.getTime() / 1000)
	)
		return null
	const entry = parseEventId(payload.actor.courseEntryEventId)
	if (!entry.ok) return null
	const runId = deriveCourseRunId({
		courseId: AI_HERO_SKILLS_WORKFLOW_COURSE_V1.courseId,
		entryEventId: entry.value,
	})
	// Both existing atomic producers remain accepted; neither reference may drift
	// from its owning payload. No new event spelling or enrollment policy.
	const legacyReference =
		row.providerReference === `value-path:${payload.actor.valuePathId}` &&
		row.providerEventId === row.semanticIdempotencyKey
	const courseReference =
		row.providerReference === `email-course:${runId}` &&
		row.providerEventId === row.id
	if (!legacyReference && !courseReference) return null
	const result = courseSequenceExhaustedStimulusFromContactEvent({
		...row,
		occurredAt: row.occurredAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
	})
	return result.ok &&
		result.value.entryFactId === row.id &&
		result.value.contactId === row.contactId
		? result.value
		: null
}

/** Synthetic fixtures only; not an entry-fact producer. */
export function sourceFixture(
	id = 'fact-a',
	path: string = SKILLS_WORKFLOW_PATH_SLUGS[0],
) {
	const contactId = `contact-${id}`
	const payload = {
		format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
		actor: {
			actorId: `email-course:${contactId}:${path}`,
			contactId,
			valuePathId: path,
			courseEntryEventId: `entry-${id}`,
		},
		exhaustedAt: '2026-09-04T17:00:00.000Z',
		deadlineTimeZone: {
			type: 'BrowserEntryHeader',
			headerName: 'x-vercel-ip-timezone',
			timeZone: 'Asia/Tokyo',
			capturedAt: '2026-08-30T02:00:00.000Z',
		},
		progression: {
			from: {
				intentId: `prior-${id}`,
				idempotencyKey: `contact:${contactId}:value-path:${path}:email:${path}.email-6`,
				emailResourceId: `${path}.email-6`,
				completedAt: '2026-09-03T12:00:00.000Z',
			},
			trigger: {
				type: 'DailyDripDue',
				evaluatedAt: '2026-09-04T17:00:00.000Z',
				reason: 'local-day-9am-due',
			},
			terminal: {
				intentId: `terminal-${id}`,
				idempotencyKey: `contact:${contactId}:value-path:${path}:email:${path}.email-7`,
				nextActionId: `action-${id}`,
				emailResourceId: `${path}.email-7`,
			},
		},
		sourceReferences: {
			courseEntryEventId: `entry-${id}`,
			priorIntentId: `prior-${id}`,
		},
	}
	const key = courseSequenceExhaustionFactKey({ contactId, valuePathId: path })
	return {
		id,
		contactId,
		providerIdentityId: `identity-${id}`,
		provider: 'ai-hero',
		providerEventId: key,
		providerReference: `value-path:${path}`,
		eventType: 'course.sequence-exhausted',
		semanticIdempotencyKey: key,
		privacyLevel: 'internal',
		identityEvidence: { source: 'ai-hero', strength: 'strong' },
		payloadSummary: {
			summary: 'Synthetic exhaustion',
			keywords: [],
			restrictedPayloadStored: false,
			coursePayload: {
				format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
				payload,
			},
		},
		schemaVersion: 1,
		occurredAt: new Date(payload.exhaustedAt),
		createdAt: new Date(payload.exhaustedAt),
	}
}
/** Matches commitSequenceExhaustionFact in email-course-drizzle-ledger.ts.
 * Separate from the legacy DailyDripDue fixture: delivery acceptance plans
 * the terminal intent, with millisecond payload time and second-granular SQL time.
 */
export function currentCourseSourceFixture(id = 'current-fact') {
	const contactId = `contact-${id}`
	const path = SKILLS_WORKFLOW_PATH_SLUGS[0]
	const entryEventId = `entry-${id}`
	const runId = `email-course:skills-workflow:${entryEventId}`
	const priorIntentId = `prior-${id}`
	const exhaustedAt = '2026-09-04T17:00:00.789Z'
	const payload = {
		format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
		actor: {
			actorId: `email-course:${contactId}:${path}`,
			contactId,
			valuePathId: path,
			courseEntryEventId: entryEventId,
		},
		exhaustedAt,
		deadlineTimeZone: {
			type: 'BrowserEntryHeader',
			headerName: 'x-vercel-ip-timezone',
			timeZone: 'Asia/Tokyo',
			capturedAt: '2026-08-30T02:00:00.000Z',
		},
		progression: {
			from: {
				intentId: priorIntentId,
				idempotencyKey: `contact:${contactId}:value-path:${path}:email:${path}.email-6`,
				emailResourceId: `${path}.email-6`,
				completedAt: exhaustedAt,
			},
			trigger: {
				type: 'DeliverySettled',
				evaluatedAt: exhaustedAt,
				plannedAvailableAt: '2026-09-06T00:00:00.000Z',
				policy: 'EighteenHourFloorThenLocalNine',
			},
			terminal: {
				intentId: `terminal-${id}`,
				idempotencyKey: `contact:${contactId}:value-path:${path}:email:${path}.email-7`,
				nextActionId: `email-course-action:${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`,
				emailResourceId: `${path}.email-7`,
			},
		},
		sourceReferences: { courseEntryEventId: entryEventId, priorIntentId },
	}
	return {
		id,
		contactId,
		providerIdentityId: `identity-${id}`,
		provider: 'ai-hero',
		providerEventId: id,
		providerReference: `email-course:${runId}`,
		eventType: 'course.sequence-exhausted',
		semanticIdempotencyKey: courseSequenceExhaustionFactKey({
			contactId,
			valuePathId: path,
		}),
		privacyLevel: 'internal',
		identityEvidence: { source: 'ai-hero', strength: 'strong' },
		payloadSummary: {
			summary: 'Email Course sequence exhausted',
			keywords: ['email-course', 'sequence-exhausted', path],
			restrictedPayloadStored: false,
			coursePayload: {
				format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
				payload,
			},
		},
		schemaVersion: 1,
		occurredAt: new Date('2026-09-04T17:00:00.000Z'),
		createdAt: new Date('2026-09-04T17:00:00.000Z'),
	}
}
export function fixtureEntry(id = 'fact-a') {
	const stimulus = restoreSourceCandidate(sourceFixture(id))
	if (!stimulus) throw new Error('Invalid source fixture')
	return fixtureCommit(null, stimulus, stimulus.exhaustedAt)
}
export function fixtureWake(
	aggregate: EvergreenOfferJourneyAggregate,
	index = 0,
) {
	const wake = [
		...aggregate.messagePlan.bridge,
		...aggregate.messagePlan.pitch,
	][index]
	if (!wake) throw new Error('Missing fixture slot')
	// Re-derive the initial decision to use its canonical wake identity.
	const initial = fixtureEntry(aggregate.entryFactId)
	const scheduled = initial.decision.wakeIntents[index]
	if (!scheduled) throw new Error('Missing fixture wake')
	const id = parseStimulusId(`wake-${index}-${aggregate.journeyId}`)
	if (!id.ok) throw new Error('Invalid fixture ID')
	return fixtureCommit(
		aggregate,
		{
			type: 'WakeDue',
			stimulusId: id.value,
			journeyId: aggregate.journeyId,
			wakeId: scheduled.wakeId,
			purpose: scheduled.purpose,
			dueAt: scheduled.dueAt,
		},
		scheduled.dueAt,
	)
}
export function fixtureCommit(
	snapshot: EvergreenOfferJourneyAggregate | null,
	stimulus: EvergreenOfferStimulus,
	at: string,
): JourneyLedgerCommit {
	const now = parseIsoInstant(at)
	if (!now.ok) throw new Error('Invalid fixture time')
	const contactId =
		snapshot?.contactId ??
		(stimulus.type === 'CourseSequenceExhausted' ? stimulus.contactId : null)
	if (!contactId) throw new Error('Missing fixture contact')
	const currentFacts: EligibilityFacts = {
		contactId,
		purchase: null,
		delivery: { type: 'Eligible' },
		existingJourneyId: snapshot?.journeyId ?? null,
		automationControl: { type: 'Enabled', version: 'fixture-control' },
		evidenceVersion: 'fixture-facts',
		readAt: now.value,
	}
	const result = decideEvergreenOfferJourney({
		snapshot,
		stimulus,
		currentFacts,
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		now: now.value,
	})
	if (!result.ok || result.decision.type !== 'Accepted')
		throw new Error('Fixture decision rejected')
	return {
		stimulus,
		currentFacts,
		definition: EVERGREEN_OFFER_JOURNEY_V1,
		expectedVersion: snapshot?.version ?? null,
		decidedAt: now.value,
		decision: result.decision,
	}
}
