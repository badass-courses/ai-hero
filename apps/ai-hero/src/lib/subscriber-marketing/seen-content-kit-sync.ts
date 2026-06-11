import type { OperatorContactSnapshot } from './operator-lookup'
import { previewSeenContent, type SeenContentPreview } from './seen-content'
import type { Gate } from './types'

export const SEEN_CONTENT_KIT_FIELD_KEYS = [
	'aih_seen_content_keys',
	'aih_seen_content_updated_at',
] as const

export type SeenContentKitFieldKey =
	(typeof SEEN_CONTENT_KIT_FIELD_KEYS)[number]
export type SeenContentKitFieldPayload = Record<SeenContentKitFieldKey, string>

export type KitSeenContentSubscriber = {
	id: string | number
	fields?: Record<string, string | null | undefined>
}

export type KitSeenContentProvider = {
	getSubscriberByEmail: (
		email: string,
	) => Promise<KitSeenContentSubscriber | null>
	updateSubscriberFields?: (args: {
		subscriberId?: string
		subscriberEmail?: string
		fields: Record<string, string>
	}) => Promise<KitSeenContentSubscriber | null>
}

export type SeenContentKitSyncResult = {
	mode: 'seen-content-kit-sync'
	syncMode: 'dry-run' | 'write'
	contactId: string
	status: 'dry-run' | 'written' | 'blocked'
	privacy: {
		rawEmailsIncluded: false
		rawPayloadIncluded: false
		customerVisibleFieldsIncluded: false
	}
	preview: SeenContentPreview
	fields: SeenContentKitFieldPayload
	kit: {
		lookupPerformed: boolean
		subscriberFound: boolean
		subscriberId?: string
		writeAttempted: boolean
		writePerformed: boolean
		updatedFieldKeys: SeenContentKitFieldKey[]
		beforeFields: Partial<SeenContentKitFieldPayload>
		afterFields?: Partial<SeenContentKitFieldPayload>
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
		kitProjectionOnly: true
	}
}

export async function syncSeenContentKitFieldsForContactSnapshot(args: {
	snapshot: OperatorContactSnapshot
	provider: KitSeenContentProvider
	allowWrite: boolean
	now?: string
}): Promise<SeenContentKitSyncResult> {
	const preview = previewSeenContent({
		contactId: args.snapshot.contact.id,
		events: args.snapshot.recentEvents,
		now: args.now,
	})
	const fields = buildSeenContentKitFieldPayload(preview)
	const email = normalizeEmail(args.snapshot.contact.email)
	if (!email) {
		return blockedResult({
			preview,
			fields,
			reason: 'missing-contact-email',
			rationale:
				'No normalized contact email is available for Kit subscriber lookup.',
		})
	}

	const subscriber = await args.provider.getSubscriberByEmail(email)
	if (!subscriber?.id) {
		return blockedResult({
			preview,
			fields,
			reason: 'kit-subscriber-not-found',
			rationale:
				'No Kit subscriber was found for this Contact. No write was attempted.',
			lookupPerformed: true,
		})
	}

	const beforeFields = pickSeenContentKitFields(subscriber.fields ?? {})
	if (!args.allowWrite) {
		return {
			mode: 'seen-content-kit-sync',
			syncMode: 'dry-run',
			contactId: preview.contactId,
			status: 'dry-run',
			privacy: privacyReceipt(),
			preview,
			fields,
			kit: {
				lookupPerformed: true,
				subscriberFound: true,
				subscriberId: String(subscriber.id),
				writeAttempted: false,
				writePerformed: false,
				updatedFieldKeys: [...SEEN_CONTENT_KIT_FIELD_KEYS],
				beforeFields,
			},
			gates: seenContentKitSyncGates('dry-run'),
			reviewReasons: [],
			rationale: [
				'Dry run resolved the Kit subscriber and prepared the bounded Seen Content projection. No Kit write was performed.',
			],
			metadata: sideEffectMetadata(false),
		}
	}

	if (!args.provider.updateSubscriberFields) {
		return blockedResult({
			preview,
			fields,
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
		fields,
	})
	const afterFields = pickSeenContentKitFields(updated?.fields ?? fields)

	return {
		mode: 'seen-content-kit-sync',
		syncMode: 'write',
		contactId: preview.contactId,
		status: 'written',
		privacy: privacyReceipt(),
		preview,
		fields,
		kit: {
			lookupPerformed: true,
			subscriberFound: true,
			subscriberId: String(subscriber.id),
			writeAttempted: true,
			writePerformed: true,
			updatedFieldKeys: [...SEEN_CONTENT_KIT_FIELD_KEYS],
			beforeFields,
			afterFields,
		},
		gates: seenContentKitSyncGates('write'),
		reviewReasons: [],
		rationale: [
			'Allowlisted write updated only the bounded Seen Content projection fields on the Kit subscriber.',
		],
		metadata: sideEffectMetadata(true),
	}
}

export function buildSeenContentKitFieldPayload(
	preview: SeenContentPreview,
): SeenContentKitFieldPayload {
	return {
		aih_seen_content_keys: preview.seenContentKeys,
		aih_seen_content_updated_at: preview.seenContentUpdatedAt,
	}
}

function blockedResult(args: {
	preview: SeenContentPreview
	fields: SeenContentKitFieldPayload
	reason: string
	rationale: string
	lookupPerformed?: boolean
	subscriberFound?: boolean
	subscriberId?: string
	beforeFields?: Partial<SeenContentKitFieldPayload>
}): SeenContentKitSyncResult {
	return {
		mode: 'seen-content-kit-sync',
		syncMode: 'dry-run',
		contactId: args.preview.contactId,
		status: 'blocked',
		privacy: privacyReceipt(),
		preview: args.preview,
		fields: args.fields,
		kit: {
			lookupPerformed: args.lookupPerformed ?? false,
			subscriberFound: args.subscriberFound ?? false,
			subscriberId: args.subscriberId,
			writeAttempted: false,
			writePerformed: false,
			updatedFieldKeys: [],
			beforeFields: args.beforeFields ?? {},
		},
		gates: seenContentKitSyncGates('blocked'),
		reviewReasons: [args.reason],
		rationale: [args.rationale],
		metadata: sideEffectMetadata(false),
	}
}

function pickSeenContentKitFields(
	fields: Record<string, string | null | undefined>,
) {
	return Object.fromEntries(
		SEEN_CONTENT_KIT_FIELD_KEYS.flatMap((key) => {
			const value = fields[key]
			return value === undefined || value === null
				? []
				: [[key, sanitizeReceiptValue(String(value))]]
		}),
	) as Partial<SeenContentKitFieldPayload>
}

function sanitizeReceiptValue(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return ''
	if (/^[a-z0-9_|:.+-]+$/i.test(trimmed) && trimmed.length <= 500)
		return trimmed
	return '[existing-value-present]'
}

function seenContentKitSyncGates(
	status: 'dry-run' | 'write' | 'blocked',
): Gate[] {
	return [
		{
			slug: 'gate-c-shadow-fields',
			passed: true,
			reason:
				'Gate C permits bounded Kit projection fields only. Full Seen Content history remains in Course Builder.',
		},
		{
			slug: 'human-review',
			passed: status !== 'blocked',
			reason:
				status === 'blocked'
					? 'The sync is blocked until the operator resolves the review reason.'
					: 'The operator explicitly requested this bounded Seen Content projection sync mode.',
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
		kitProjectionOnly: true,
	} as const
}

function privacyReceipt() {
	return {
		rawEmailsIncluded: false,
		rawPayloadIncluded: false,
		customerVisibleFieldsIncluded: false,
	} as const
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}
