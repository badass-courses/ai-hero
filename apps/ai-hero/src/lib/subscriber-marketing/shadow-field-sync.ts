import { log } from '@/server/logger'
import type { OperatorContactSnapshot } from './operator-lookup'
import {
	previewShadowFieldsForContactSnapshot,
	SHADOW_FIELD_KEYS,
	type ShadowFieldPayload,
	type ShadowFieldPreviewResult,
} from './shadow-field-planner'
import type { Gate } from './types'
import type { ValuePathCandidate } from './value-path-planner'

export type KitShadowFieldSubscriber = {
	id: string | number
	fields?: Record<string, string | null | undefined>
}

export type KitShadowFieldProvider = {
	getSubscriberByEmail: (
		email: string,
	) => Promise<KitShadowFieldSubscriber | null>
	updateSubscriberFields?: (args: {
		subscriberId?: string
		subscriberEmail?: string
		fields: Record<string, string>
	}) => Promise<KitShadowFieldSubscriber | null>
}

export type ShadowFieldSyncMode = 'dry-run' | 'write'

export type ShadowFieldSyncResult = {
	mode: 'shadow-field-sync'
	syncMode: ShadowFieldSyncMode
	contactId: string
	status: 'dry-run' | 'written' | 'blocked'
	privacy: {
		rawEmailsIncluded: false
		rawPayloadIncluded: false
		customerVisibleFieldsIncluded: false
	}
	preview: ShadowFieldPreviewResult
	kit: {
		lookupPerformed: boolean
		subscriberFound: boolean
		subscriberId?: string
		writeAttempted: boolean
		writePerformed: boolean
		updatedFieldKeys: string[]
		beforeFields: Partial<ShadowFieldPayload>
		afterFields?: Partial<ShadowFieldPayload>
	}
	gates: Gate[]
	reviewReasons: string[]
	rationale: string[]
	metadata: {
		kitWrites: boolean
		frontWrites: false
		sequenceEnrollment: false
		contactStateWrite: false
		customerVisibleSideEffects: false
		shadowFieldsOnly: true
	}
}

export async function syncShadowFieldsForContactSnapshot(args: {
	snapshot: OperatorContactSnapshot
	valuePathCandidate?: ValuePathCandidate
	provider: KitShadowFieldProvider
	allowWrite: boolean
	acceptedReviewReasons?: readonly string[]
}): Promise<ShadowFieldSyncResult> {
	const preview = previewShadowFieldsForContactSnapshot({
		snapshot: args.snapshot,
		valuePathCandidate: args.valuePathCandidate,
	})
	const email = normalizeEmail(args.snapshot.contact.email)
	if (!email) {
		return blockedResult({
			preview,
			reason: 'missing-contact-email',
			rationale:
				'No normalized contact email is available for Kit subscriber lookup.',
		})
	}

	const subscriber = await args.provider.getSubscriberByEmail(email)
	if (!subscriber?.id) {
		return blockedResult({
			preview,
			reason: 'kit-subscriber-not-found',
			rationale:
				'No Kit subscriber was found for this Contact. No write was attempted.',
			lookupPerformed: true,
		})
	}

	const beforeFields = pickShadowFields(subscriber.fields ?? {})
	if (!args.allowWrite) {
		await log.info('subscriber_funnel.shadow_field_sync_result', {
			funnel: 'skills-newsletter', contactId: preview.contactId,
			status: 'dry-run', subscriberFound: true, writePerformed: false,
		})
		return {
			mode: 'shadow-field-sync',
			syncMode: 'dry-run',
			contactId: preview.contactId,
			status: 'dry-run',
			privacy: preview.privacy,
			preview,
			kit: {
				lookupPerformed: true,
				subscriberFound: true,
				subscriberId: String(subscriber.id),
				writeAttempted: false,
				writePerformed: false,
				updatedFieldKeys: [...SHADOW_FIELD_KEYS],
				beforeFields,
			},
			gates: shadowFieldSyncGates('dry-run'),
			reviewReasons: preview.reviewReasons,
			rationale: [
				'Dry run resolved the Kit subscriber and prepared the bounded shadow field payload. No Kit write was performed.',
			],
			metadata: sideEffectMetadata(false),
		}
	}

	const reviewBlocker = reviewWriteBlocker({
		preview,
		acceptedReviewReasons: args.acceptedReviewReasons ?? [],
	})
	if (reviewBlocker) {
		return blockedResult({
			preview,
			reason: reviewBlocker.reason,
			rationale: reviewBlocker.rationale,
			lookupPerformed: true,
			subscriberFound: true,
			subscriberId: String(subscriber.id),
			beforeFields,
		})
	}

	if (!args.provider.updateSubscriberFields) {
		return blockedResult({
			preview,
			reason: 'kit-update-not-supported',
			rationale:
				'The configured Kit provider does not support subscriber field updates.',
			lookupPerformed: true,
			subscriberFound: true,
			subscriberId: String(subscriber.id),
			beforeFields,
		})
	}

	const updated = await args.provider.updateSubscriberFields({
		subscriberId: String(subscriber.id),
		fields: preview.fields,
	})
	const afterFields = pickShadowFields(updated?.fields ?? preview.fields)
	await log.info('subscriber_funnel.shadow_field_sync_result', {
		funnel: 'skills-newsletter', contactId: preview.contactId,
		status: 'written', subscriberFound: true, writePerformed: true,
		updatedFieldCount: SHADOW_FIELD_KEYS.length,
	})

	return {
		mode: 'shadow-field-sync',
		syncMode: 'write',
		contactId: preview.contactId,
		status: 'written',
		privacy: preview.privacy,
		preview,
		kit: {
			lookupPerformed: true,
			subscriberFound: true,
			subscriberId: String(subscriber.id),
			writeAttempted: true,
			writePerformed: true,
			updatedFieldKeys: [...SHADOW_FIELD_KEYS],
			beforeFields,
			afterFields,
		},
		gates: shadowFieldSyncGates('write'),
		reviewReasons: preview.reviewReasons,
		rationale: [
			'Allowlisted write updated only bounded aih_ shadow fields on the Kit subscriber.',
		],
		metadata: sideEffectMetadata(true),
	}
}

function reviewWriteBlocker(args: {
	preview: ShadowFieldPreviewResult
	acceptedReviewReasons: readonly string[]
}) {
	if (args.preview.status === 'blocked') {
		return {
			reason: 'shadow-field-preview-blocked',
			rationale:
				'This Contact has a blocked shadow field preview. Resolve the blocker before any Kit shadow field write.',
		}
	}

	if (!args.preview.reviewReasons.length) return undefined

	const accepted = new Set(args.acceptedReviewReasons.map(slugifyStable))
	const unaccepted = args.preview.reviewReasons.filter(
		(reason) => !accepted.has(slugifyStable(reason)),
	)
	if (!unaccepted.length) return undefined

	return {
		reason: `unaccepted-review-reason:${unaccepted.join(',')}`,
		rationale:
			'Human-review shadow field writes require explicit operator acceptance of every review reason before Kit is updated.',
	}
}

async function blockedResult(args: {
	preview: ShadowFieldPreviewResult
	reason: string
	rationale: string
	lookupPerformed?: boolean
	subscriberFound?: boolean
	subscriberId?: string
	beforeFields?: Partial<ShadowFieldPayload>
}): Promise<ShadowFieldSyncResult> {
	await log.warn('subscriber_funnel.shadow_field_sync_result', {
		funnel: 'skills-newsletter', contactId: args.preview.contactId,
		status: 'blocked', subscriberFound: args.subscriberFound ?? false,
		writePerformed: false, reviewReasons: [...args.preview.reviewReasons, args.reason],
	})
	return {
		mode: 'shadow-field-sync',
		syncMode: 'dry-run',
		contactId: args.preview.contactId,
		status: 'blocked',
		privacy: args.preview.privacy,
		preview: args.preview,
		kit: {
			lookupPerformed: args.lookupPerformed ?? false,
			subscriberFound: args.subscriberFound ?? false,
			subscriberId: args.subscriberId,
			writeAttempted: false,
			writePerformed: false,
			updatedFieldKeys: [],
			beforeFields: args.beforeFields ?? {},
		},
		gates: shadowFieldSyncGates('blocked'),
		reviewReasons: [...args.preview.reviewReasons, args.reason],
		rationale: [args.rationale],
		metadata: sideEffectMetadata(false),
	}
}

function pickShadowFields(fields: Record<string, string | null | undefined>) {
	return Object.fromEntries(
		SHADOW_FIELD_KEYS.flatMap((key) => {
			const value = fields[key]
			return value === undefined || value === null
				? []
				: [[key, sanitizeShadowFieldReceiptValue(String(value))]]
		}),
	) as Partial<ShadowFieldPayload>
}

function sanitizeShadowFieldReceiptValue(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return ''
	if (/^[a-z0-9_.:,+-]+$/i.test(trimmed) && trimmed.length <= 120) {
		return trimmed
	}
	return '[existing-value-present]'
}

function shadowFieldSyncGates(status: 'dry-run' | 'write' | 'blocked'): Gate[] {
	return [
		{
			slug: 'gate-c-shadow-fields',
			passed: true,
			reason:
				'Gate C permits bounded aih_ shadow fields only. CTA, offer, sequence, resource, product, and customer-facing fields are excluded.',
		},
		{
			slug: 'human-review',
			passed: status !== 'blocked',
			reason:
				status === 'blocked'
					? 'The sync is blocked until the operator resolves the review reason.'
					: 'The operator explicitly requested this bounded shadow field sync mode.',
		},
		{
			slug: 'customer-visible-side-effects',
			passed: false,
			reason:
				'No Front write, sequence enrollment, Contact State write, CTA, offer, resource, or customer-visible behavior is allowed.',
		},
	]
}

function sideEffectMetadata(kitWrites: boolean) {
	return {
		kitWrites,
		frontWrites: false,
		sequenceEnrollment: false,
		contactStateWrite: false,
		customerVisibleSideEffects: false,
		shadowFieldsOnly: true,
	} as const
}

function slugifyStable(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}
