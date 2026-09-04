import {
	COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
	readCoursePayload,
	restoreCourseSequenceExhaustedPayload,
} from '../course-sequence-exhaustion'
import type { ContactEventRecord } from '../types'
import type { CourseSequenceExhausted } from './domain'
import {
	parseContactId,
	parseEntryFactId,
	parseStimulusId,
} from './primitives'

export function courseSequenceExhaustedStimulusFromContactEvent(
	event: ContactEventRecord,
):
	| { readonly ok: true; readonly value: CourseSequenceExhausted }
	| { readonly ok: false; readonly reason: string } {
	const storedPayload = readCoursePayload(event.payloadSummary)
	const payloadFormat = event.payloadFormat ?? storedPayload?.format
	const domainFactKey = event.domainFactKey ?? event.semanticIdempotencyKey
	const domainPayload = event.domainPayload ?? storedPayload?.payload
	if (
		event.eventType !== COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE ||
		payloadFormat !== COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT ||
		!domainFactKey
	) {
		return { ok: false, reason: 'not-sequence-exhaustion-fact' }
	}
	const payload = restoreCourseSequenceExhaustedPayload(domainPayload)
	if (
		!payload ||
		payload.actor.contactId !== event.contactId ||
		domainFactKey !==
			courseSequenceExhaustionFactKey({
				contactId: payload.actor.contactId,
				valuePathId: payload.actor.valuePathId,
			}) ||
		event.semanticIdempotencyKey !== domainFactKey
	) {
		return { ok: false, reason: 'invalid-sequence-exhaustion-payload' }
	}
	const contactId = parseContactId(event.contactId)
	const entryFactId = parseEntryFactId(event.id)
	const stimulusId = parseStimulusId(event.id)
	if (!contactId.ok || !entryFactId.ok || !stimulusId.ok) {
		return { ok: false, reason: 'invalid-sequence-exhaustion-identity' }
	}
	return {
		ok: true,
		value: {
			type: 'CourseSequenceExhausted',
			stimulusId: stimulusId.value,
			entryFactId: entryFactId.value,
			contactId: contactId.value,
			valuePathId: payload.actor.valuePathId,
			exhaustedAt: payload.exhaustedAt,
			deadlineTimeZone: payload.deadlineTimeZone,
			sourceReference: `side-effect-intent:${payload.sourceReferences.priorIntentId}`,
		},
	}
}
