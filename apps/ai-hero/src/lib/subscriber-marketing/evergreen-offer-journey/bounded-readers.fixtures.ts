import {
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
} from '../course-sequence-exhaustion'
import { SKILLS_WORKFLOW_PATH_SLUGS } from '../skills-workflow-path'
import { restoreSourceCandidate } from './bounded-readers'
import { decideEvergreenOfferJourney } from './decision'
import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type {
	EligibilityFacts,
	EvergreenOfferJourneyAggregate,
	EvergreenOfferStimulus,
} from './domain'
import type { JourneyLedgerCommit } from './ports'
import { parseIsoInstant, parseStimulusId } from './primitives'

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
