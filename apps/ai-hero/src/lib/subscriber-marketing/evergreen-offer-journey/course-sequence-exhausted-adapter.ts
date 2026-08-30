import {
	COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
	courseSequenceExhaustionFactKey,
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
	if (
		event.eventType !== COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE ||
		event.payloadFormat !== COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT ||
		!event.domainFactKey
	) {
		return { ok: false, reason: 'not-sequence-exhaustion-fact' }
	}
	const payload = restoreCourseSequenceExhaustedPayload(event.domainPayload)
	if (
		!payload ||
		payload.actor.contactId !== event.contactId ||
		event.domainFactKey !==
			courseSequenceExhaustionFactKey({
				contactId: payload.actor.contactId,
				valuePathId: payload.actor.valuePathId,
			}) ||
		event.semanticIdempotencyKey !== event.domainFactKey
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
