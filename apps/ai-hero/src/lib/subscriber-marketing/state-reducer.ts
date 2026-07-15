import {
	CONTACT_STATE_SCHEMA_VERSION,
	type ClassificationResult,
	type ContactEventRecord,
	type ContactState,
} from './types'

export function reduceContactState(args: {
	existingState?: ContactState
	event: ContactEventRecord
	classification: ClassificationResult
	now: string
	id: string
}): ContactState {
	const previous = args.existingState
	return {
		id: previous?.id ?? args.id,
		contactId: args.event.contactId,
		lifecycle: args.classification.humanReview ? 'human-review' : 'classified',
		primaryBucket: args.classification.primaryBucket,
		allBuckets: Array.from(
			new Set([
				...(previous?.allBuckets ?? []),
				...args.classification.allBuckets,
			]),
		),
		whySignals: Array.from(
			new Set([
				...(previous?.whySignals ?? []),
				...args.classification.whySignals,
			]),
		),
		whoSignals: Array.from(
			new Set([
				...(previous?.whoSignals ?? []),
				...args.classification.whoSignals,
			]),
		),
		confidence: Math.max(
			previous?.confidence ?? 0,
			args.classification.confidence,
		),
		rationale: [
			...(previous?.rationale ?? []),
			...args.classification.rationale,
		].slice(-10),
		reviewSignals: Array.from(
			new Set([
				...(previous?.reviewSignals ?? []),
				...args.classification.reviewSignals,
			]),
		),
		humanReview: Boolean(
			previous?.humanReview || args.classification.humanReview,
		),
		optInAttribution:
			previous?.optInAttribution ?? args.event.optInAttribution ?? null,
		lastEventId: args.event.id,
		schemaVersion: CONTACT_STATE_SCHEMA_VERSION,
		updatedAt: args.now,
	}
}
