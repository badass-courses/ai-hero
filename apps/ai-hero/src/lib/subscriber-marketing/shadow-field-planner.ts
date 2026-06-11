import type { OperatorContactSnapshot } from './operator-lookup'
import type { ValuePathCandidate } from './value-path-planner'
import type {
	BucketSlug,
	ContactEventRecord,
	ContactState,
	Gate,
	ReviewSignalSlug,
	WhoSignalSlug,
	WhySignalSlug,
} from './types'

export const SHADOW_FIELD_KEYS = [
	'aih_why_primary',
	'aih_who_primary',
	'aih_confidence',
	'aih_human_review',
	'aih_review_reason',
	'aih_last_signal_at',
	'aih_contact_state',
	'aih_next_action',
] as const

export type ShadowFieldKey = (typeof SHADOW_FIELD_KEYS)[number]

export const EXCLUDED_CTA_FIELD_KEYS = [
	'aih_cta',
	'aih_cta_url',
	'aih_cta_label',
	'aih_offer',
	'aih_offer_slug',
	'aih_product_id',
	'aih_sequence',
	'aih_resource_recommendation',
] as const

export type ShadowFieldPayload = Record<ShadowFieldKey, string>

export type ShadowFieldPreviewResult = {
	mode: 'shadow-field-preview'
	contactId: string
	status: 'review-only' | 'human-review' | 'blocked'
	privacy: {
		rawPayloadIncluded: false
		rawEmailsIncluded: false
		customerVisibleFieldsIncluded: false
	}
	fields: ShadowFieldPayload
	fieldKeys: ShadowFieldKey[]
	excludedFieldKeys: typeof EXCLUDED_CTA_FIELD_KEYS
	gates: Gate[]
	reviewReasons: string[]
	rationale: string[]
	metadata: {
		kitWrites: false
		frontWrites: false
		sequenceEnrollment: false
		contactStateWrite: false
		customerVisibleSideEffects: false
		shadowFieldsOnly: true
	}
}

export function previewShadowFieldsForContactSnapshot(args: {
	snapshot: OperatorContactSnapshot
	valuePathCandidate?: ValuePathCandidate
}): ShadowFieldPreviewResult {
	if (!args.snapshot.currentState) {
		return buildMissingStatePreview(args.snapshot.contact.id)
	}

	return previewShadowFields({
		contactId: args.snapshot.contact.id,
		state: args.snapshot.currentState,
		recentEvents: args.snapshot.recentEvents,
		valuePathCandidate: args.valuePathCandidate,
	})
}

export function previewShadowFields(args: {
	contactId: string
	state: ContactState
	recentEvents?: ContactEventRecord[]
	valuePathCandidate?: ValuePathCandidate
}): ShadowFieldPreviewResult {
	const reviewReasons = stableReviewReasons({
		stateReviewSignals: args.state.reviewSignals,
		valuePathReviewReasons: args.valuePathCandidate?.reviewReasons ?? [],
	})
	const status = previewStatus(args.state, args.valuePathCandidate)
	const fields = buildShadowFieldPayload({
		state: args.state,
		recentEvents: args.recentEvents ?? [],
		status,
		reviewReasons,
	})

	return {
		mode: 'shadow-field-preview',
		contactId: args.contactId,
		status,
		privacy: {
			rawPayloadIncluded: false,
			rawEmailsIncluded: false,
			customerVisibleFieldsIncluded: false,
		},
		fields,
		fieldKeys: [...SHADOW_FIELD_KEYS],
		excludedFieldKeys: EXCLUDED_CTA_FIELD_KEYS,
		gates: shadowFieldGates(status),
		reviewReasons,
		rationale: rationaleForStatus(status),
		metadata: {
			kitWrites: false,
			frontWrites: false,
			sequenceEnrollment: false,
			contactStateWrite: false,
			customerVisibleSideEffects: false,
			shadowFieldsOnly: true,
		},
	}
}

function buildMissingStatePreview(contactId: string): ShadowFieldPreviewResult {
	const reviewReasons = ['missing-contact-state']
	return {
		mode: 'shadow-field-preview',
		contactId,
		status: 'human-review',
		privacy: {
			rawPayloadIncluded: false,
			rawEmailsIncluded: false,
			customerVisibleFieldsIncluded: false,
		},
		fields: {
			aih_why_primary: 'other-unclear',
			aih_who_primary: 'unclear',
			aih_confidence: '0.00',
			aih_human_review: 'true',
			aih_review_reason: reviewReasons.join(','),
			aih_last_signal_at: '',
			aih_contact_state: 'human-review',
			aih_next_action: 'human-review',
		},
		fieldKeys: [...SHADOW_FIELD_KEYS],
		excludedFieldKeys: EXCLUDED_CTA_FIELD_KEYS,
		gates: shadowFieldGates('human-review'),
		reviewReasons,
		rationale: rationaleForStatus('human-review'),
		metadata: {
			kitWrites: false,
			frontWrites: false,
			sequenceEnrollment: false,
			contactStateWrite: false,
			customerVisibleSideEffects: false,
			shadowFieldsOnly: true,
		},
	}
}

function buildShadowFieldPayload(args: {
	state: ContactState
	recentEvents: ContactEventRecord[]
	status: ShadowFieldPreviewResult['status']
	reviewReasons: string[]
}): ShadowFieldPayload {
	return {
		aih_why_primary: primaryWhySignal(args.state),
		aih_who_primary: primaryWhoSignal(args.state),
		aih_confidence: boundedConfidence(args.state.confidence),
		aih_human_review: String(
			args.status !== 'review-only' || args.state.humanReview,
		),
		aih_review_reason: args.reviewReasons.length
			? args.reviewReasons.join(',')
			: 'none',
		aih_last_signal_at: latestSignalAt(args.state, args.recentEvents),
		aih_contact_state: args.state.lifecycle,
		aih_next_action: nextAction(args.status),
	}
}

function primaryWhySignal(state: ContactState): WhySignalSlug {
	const primary = state.primaryBucket
	if (isWhySignal(primary)) return primary
	return state.whySignals[0] ?? 'other-unclear'
}

function primaryWhoSignal(state: ContactState): WhoSignalSlug {
	const primary = state.primaryBucket
	if (isWhoSignal(primary)) return primary
	return state.whoSignals[0] ?? 'unclear'
}

function isWhySignal(value: BucketSlug): value is WhySignalSlug {
	return value !== 'unclear' && !isWhoSignal(value)
}

function isWhoSignal(value: BucketSlug): value is WhoSignalSlug {
	return [
		'professional-software-engineer',
		'technical-team-leader',
		'educator-content-community-builder',
		'nontraditional-early-technical-learner',
		'data-research-ai-practitioner',
		'founder-product-builder',
		'unclear',
	].includes(value)
}

function boundedConfidence(confidence: number) {
	const bounded = Math.max(0, Math.min(1, confidence))
	return bounded.toFixed(2)
}

function latestSignalAt(
	state: ContactState,
	recentEvents: ContactEventRecord[],
) {
	const eventTimes = recentEvents.map((event) => event.occurredAt)
	return [state.updatedAt, ...eventTimes].sort().at(-1) ?? state.updatedAt
}

function previewStatus(
	state: ContactState,
	valuePathCandidate?: ValuePathCandidate,
): ShadowFieldPreviewResult['status'] {
	if (valuePathCandidate?.status === 'blocked') return 'blocked'
	if (state.humanReview || valuePathCandidate?.status === 'human-review') {
		return 'human-review'
	}
	return 'review-only'
}

function nextAction(status: ShadowFieldPreviewResult['status']) {
	if (status === 'blocked') return 'suppress'
	if (status === 'human-review') return 'human-review'
	return 'review-shadow-fields'
}

function stableReviewReasons(args: {
	stateReviewSignals: ReviewSignalSlug[]
	valuePathReviewReasons: string[]
}) {
	return Array.from(
		new Set([...args.stateReviewSignals, ...args.valuePathReviewReasons]),
	)
		.map(slugifyStable)
		.filter(Boolean)
		.sort()
}

function slugifyStable(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function shadowFieldGates(status: ShadowFieldPreviewResult['status']): Gate[] {
	return [
		{
			slug: 'gate-b-internal-capture',
			passed: true,
			reason:
				'Gate B internal Contact State is available for preview planning.',
		},
		{
			slug: 'gate-c-shadow-fields',
			passed: true,
			reason:
				'Gate C preview emits bounded aih_ shadow fields only. No provider write is performed.',
		},
		{
			slug: 'human-review',
			passed: status === 'review-only',
			reason:
				status === 'review-only'
					? 'No mandatory review blocker for shadow field preview output.'
					: 'Human review is required before any synced or customer-visible step.',
		},
		{
			slug: 'customer-visible-side-effects',
			passed: false,
			reason:
				'AIH-118 starts preview-only. No Kit writes, Front writes, sequence enrollment, Contact State write, CTA, or customer-visible side effect is allowed.',
		},
	]
}

function rationaleForStatus(status: ShadowFieldPreviewResult['status']) {
	if (status === 'blocked') {
		return [
			'Blocked contacts receive only safe suppression and review shadow fields in preview output.',
		]
	}
	if (status === 'human-review') {
		return [
			'Human-review contacts receive only safe review shadow fields. CTA, offer, sequence, and resource fields are excluded.',
		]
	}
	return [
		'Preview emits internal aih_ shadow fields for operator review only. CTA, offer, sequence, and resource fields are excluded.',
	]
}
