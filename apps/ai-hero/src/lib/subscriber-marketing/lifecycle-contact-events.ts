import type {
	ContactEventPreviewRepository,
	ContactEventWriteRepository,
} from './contact-event-normalizer-preview'
import {
	CONTACT_EVENT_SCHEMA_VERSION,
	type ContactEventRecord,
	type ContactIdentityEvidence,
	type ContactRecord,
	type NormalizedContactEvent,
	type ProviderIdentityRecord,
} from './types'

/**
 * Lifecycle Contact Events: purchase.recorded and contact.unsubscribed.
 *
 * These land in the ContactEvent log so history replays (drovr shadow parity)
 * can see that a contact bought or opted out instead of over-planning emails
 * for them. They follow the content-read/shortlink preview-write pattern:
 * direct ContactEvent writes against existing contacts only, with no
 * classifier, no ContactState mutation, and no side-effect intents.
 */

export type PurchaseRecordedSource = {
	purchaseId: string
	userId?: string | null
	email?: string | null
	name?: string | null
	productId: string
	status: string
	totalAmount: string | number
	/** ISO timestamp from the Purchase row's createdAt. */
	purchasedAt: string
}

export type ContactUnsubscribedSource = {
	email: string
	kitSubscriberId?: string | null
	preferenceKey: string
	/** Where the unsubscribe signal reached ai-hero (preferences-page, unsubscribe-link, ...). */
	source: string
	/** ISO timestamp: the action time forward, the stored optOutAt on backfill. */
	occurredAt: string
}

export type LifecycleContactEventSourceKind =
	| 'purchase-recorded'
	| 'contact-unsubscribed'

export type LifecycleContactEventDecision =
	| {
			status: 'eligible'
			source: LifecycleContactEventSourceKind
			sourceId: string
			contactId: string
			providerIdentityId?: string
			wouldCreateProviderIdentity: boolean
			identityResolutionPath: string
			wouldCreate: NormalizedContactEvent
	  }
	| {
			status: 'skipped'
			source: LifecycleContactEventSourceKind
			sourceId: string
			reason:
				| 'no-existing-contact'
				| 'no-identity-evidence'
				| 'duplicate-semantic-key'
			detail: string
	  }

export type LifecycleContactEventSummary = {
	mode: 'preview' | 'write'
	counts: {
		rows: number
		eligible: number
		written: number
		skipped: number
		skippedByReason: Record<string, number>
		createdProviderIdentities: number
	}
	decisions: LifecycleContactEventDecision[]
	written: ContactEventRecord[]
}

const normalizeEmail = (email?: string | null) => {
	const normalized = email?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}

export function purchaseRecordedSemanticKey(purchaseId: string) {
	return `ai-hero:purchase.recorded:purchase:${purchaseId}`.toLowerCase()
}

export function contactUnsubscribedSemanticKey(
	email: string,
	preferenceKey: string,
) {
	return `kit:contact.unsubscribed:${email.trim().toLowerCase()}:${preferenceKey}`.toLowerCase()
}

/**
 * Payload summaries deliberately avoid signal-taxonomy keywords (purchase,
 * buy, refund, newsletter, course, ...) as bare tokens. Hyphenated keywords do
 * not match single-token taxonomy entries, so a later classification pass
 * cannot misread these operational records as buying/support intent.
 */
export function buildPurchaseRecordedEvent(
	source: PurchaseRecordedSource,
	evidence: ContactIdentityEvidence,
): NormalizedContactEvent {
	return {
		provider: 'ai-hero',
		providerEventId: `purchase:${source.purchaseId}`,
		providerReference: `ai-hero:purchase:${source.purchaseId}`,
		eventType: 'purchase.recorded',
		occurredAt: source.purchasedAt,
		semanticIdempotencyKey: purchaseRecordedSemanticKey(source.purchaseId),
		privacyLevel: 'internal',
		identityEvidence: evidence,
		payloadSummary: {
			summary: `Order recorded for product ${source.productId} with status ${source.status}.`,
			keywords: [
				'purchase-recorded',
				source.productId,
				`status-${source.status.toLowerCase()}`,
			],
			restrictedPayloadStored: false,
		},
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
	}
}

export function buildContactUnsubscribedEvent(
	source: ContactUnsubscribedSource,
	evidence: ContactIdentityEvidence,
): NormalizedContactEvent {
	const email = source.email.trim().toLowerCase()
	return {
		provider: 'kit',
		providerEventId: `email-preference-opt-out:${source.preferenceKey}:${email}`,
		providerReference: `kit:email-preference:${source.preferenceKey}`,
		eventType: 'contact.unsubscribed',
		occurredAt: source.occurredAt,
		semanticIdempotencyKey: contactUnsubscribedSemanticKey(
			email,
			source.preferenceKey,
		),
		privacyLevel: 'internal',
		identityEvidence: evidence,
		payloadSummary: {
			summary: `Email preference opt-out recorded for preference-${source.preferenceKey}.`,
			keywords: [
				'contact-unsubscribed',
				`preference-${source.preferenceKey}`,
				`source-${source.source}`,
			],
			restrictedPayloadStored: false,
		},
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
	}
}

type LifecycleIdentityInput = {
	userId?: string | null
	kitSubscriberId?: string | null
	email?: string | null
	name?: string | null
}

type LifecycleIdentityResolution =
	| {
			status: 'resolved'
			contact: ContactRecord
			providerIdentity?: ProviderIdentityRecord
			pendingProviderIdentity?: { provider: 'ai-hero'; externalId: string }
			evidence: ContactIdentityEvidence
			path: string
	  }
	| {
			status: 'skipped'
			reason: 'no-existing-contact' | 'no-identity-evidence'
			detail: string
	  }

/**
 * Attaches lifecycle events to EXISTING contacts only. An unsubscribe or
 * purchase for an email the marketing log has never seen carries no replay
 * risk (there is no history to over-plan), so unresolved rows are skipped
 * instead of creating provisional contacts.
 */
async function resolveLifecycleIdentity(
	repository: ContactEventPreviewRepository,
	input: LifecycleIdentityInput,
): Promise<LifecycleIdentityResolution> {
	const email = normalizeEmail(input.email)
	if (!input.userId && !input.kitSubscriberId && !email) {
		return {
			status: 'skipped',
			reason: 'no-identity-evidence',
			detail: 'Source row carries no userId, kitSubscriberId, or email.',
		}
	}

	const evidenceFor = (
		contact: ContactRecord,
		providerIdentity: { provider: 'ai-hero' | 'kit'; externalId: string },
	): ContactIdentityEvidence => ({
		email: contact.email ?? email,
		name: contact.name ?? input.name ?? undefined,
		userId: contact.userId ?? input.userId ?? undefined,
		providerIdentity,
		source: providerIdentity.provider,
		strength: 'strong',
	})

	if (input.userId) {
		const identity = await repository.findProviderIdentity(
			'ai-hero',
			input.userId,
		)
		const contact = identity
			? await repository.findContactById(identity.contactId)
			: undefined
		if (identity && contact) {
			return {
				status: 'resolved',
				contact,
				providerIdentity: identity,
				evidence: evidenceFor(contact, {
					provider: 'ai-hero',
					externalId: input.userId,
				}),
				path: 'user-id-existing-ai-hero-provider-identity',
			}
		}
	}

	if (input.kitSubscriberId) {
		const identity = await repository.findProviderIdentity(
			'kit',
			input.kitSubscriberId,
		)
		const contact = identity
			? await repository.findContactById(identity.contactId)
			: undefined
		if (identity && contact) {
			return {
				status: 'resolved',
				contact,
				providerIdentity: identity,
				evidence: evidenceFor(contact, {
					provider: 'kit',
					externalId: input.kitSubscriberId,
				}),
				path: 'kit-subscriber-existing-provider-identity',
			}
		}
	}

	const contact =
		(input.userId
			? await repository.findContactByUserId(input.userId)
			: undefined) ?? (email ? await repository.findContactByEmail(email) : undefined)
	if (!contact) {
		return {
			status: 'skipped',
			reason: 'no-existing-contact',
			detail: 'No existing Contact matches the source row identity evidence.',
		}
	}

	// The contact exists but lacks a trusted identity row for this evidence.
	// Follow the linkAiHeroUserIdentities convention: key the ai-hero identity
	// by userId when known so later userId lookups resolve, else by contact id.
	// (provider, externalId) is unique, so an externalId already claimed by a
	// different contact falls back to the contact-id key instead of colliding.
	const path = input.userId
		? 'contact-by-user-id-link-ai-hero-identity'
		: 'contact-by-email-link-ai-hero-identity'
	for (const externalId of Array.from(
		new Set([input.userId ?? contact.userId ?? contact.id, contact.id]),
	)) {
		const existingAiHeroIdentity = await repository.findProviderIdentity(
			'ai-hero',
			externalId,
		)
		if (!existingAiHeroIdentity) {
			return {
				status: 'resolved',
				contact,
				pendingProviderIdentity: { provider: 'ai-hero', externalId },
				evidence: evidenceFor(contact, { provider: 'ai-hero', externalId }),
				path,
			}
		}
		if (existingAiHeroIdentity.contactId === contact.id) {
			return {
				status: 'resolved',
				contact,
				providerIdentity: existingAiHeroIdentity,
				evidence: evidenceFor(contact, { provider: 'ai-hero', externalId }),
				path,
			}
		}
	}
	return {
		status: 'skipped',
		reason: 'no-existing-contact',
		detail: `Contact ${contact.id} exists but every candidate ai-hero identity key is claimed by another contact.`,
	}
}

async function decideLifecycleContactEvent(args: {
	repository: ContactEventPreviewRepository
	source: LifecycleContactEventSourceKind
	sourceId: string
	identity: LifecycleIdentityInput
	build: (evidence: ContactIdentityEvidence) => NormalizedContactEvent
}): Promise<LifecycleContactEventDecision> {
	const resolved = await resolveLifecycleIdentity(args.repository, args.identity)
	if (resolved.status === 'skipped') {
		return {
			status: 'skipped',
			source: args.source,
			sourceId: args.sourceId,
			reason: resolved.reason,
			detail: resolved.detail,
		}
	}
	const event = args.build(resolved.evidence)
	const existing = await args.repository.findContactEventBySemanticKey(
		event.semanticIdempotencyKey,
	)
	if (existing) {
		return {
			status: 'skipped',
			source: args.source,
			sourceId: args.sourceId,
			reason: 'duplicate-semantic-key',
			detail: `Contact Event already exists for ${event.semanticIdempotencyKey}`,
		}
	}
	return {
		status: 'eligible',
		source: args.source,
		sourceId: args.sourceId,
		contactId: resolved.contact.id,
		providerIdentityId: resolved.providerIdentity?.id,
		wouldCreateProviderIdentity: Boolean(resolved.pendingProviderIdentity),
		identityResolutionPath: resolved.path,
		wouldCreate: event,
	}
}

function previewPurchaseRecordedDecision(
	repository: ContactEventPreviewRepository,
	row: PurchaseRecordedSource,
) {
	return decideLifecycleContactEvent({
		repository,
		source: 'purchase-recorded',
		sourceId: row.purchaseId,
		identity: {
			userId: row.userId,
			email: row.email,
			name: row.name,
		},
		build: (evidence) => buildPurchaseRecordedEvent(row, evidence),
	})
}

function previewContactUnsubscribedDecision(
	repository: ContactEventPreviewRepository,
	row: ContactUnsubscribedSource,
) {
	return decideLifecycleContactEvent({
		repository,
		source: 'contact-unsubscribed',
		sourceId: `${row.email.trim().toLowerCase()}:${row.preferenceKey}`,
		identity: {
			kitSubscriberId: row.kitSubscriberId,
			email: row.email,
		},
		build: (evidence) => buildContactUnsubscribedEvent(row, evidence),
	})
}

function summarize(
	mode: 'preview' | 'write',
	decisions: LifecycleContactEventDecision[],
	written: ContactEventRecord[],
	createdProviderIdentities: number,
): LifecycleContactEventSummary {
	const skipped = decisions.filter(
		(decision) => decision.status === 'skipped',
	) as Extract<LifecycleContactEventDecision, { status: 'skipped' }>[]
	const skippedByReason: Record<string, number> = {}
	for (const decision of skipped) {
		skippedByReason[decision.reason] =
			(skippedByReason[decision.reason] ?? 0) + 1
	}
	return {
		mode,
		counts: {
			rows: decisions.length,
			eligible: decisions.filter((decision) => decision.status === 'eligible')
				.length,
			written: written.length,
			skipped: skipped.length,
			skippedByReason,
			createdProviderIdentities,
		},
		decisions,
		written,
	}
}

async function writeLifecycleDecisions(args: {
	repository: ContactEventWriteRepository
	decisions: LifecycleContactEventDecision[]
	now: string
}) {
	const written: ContactEventRecord[] = []
	let createdProviderIdentities = 0
	for (const decision of args.decisions) {
		if (decision.status !== 'eligible') continue
		let providerIdentityId = decision.providerIdentityId
		if (!providerIdentityId) {
			const providerIdentityEvidence =
				decision.wouldCreate.identityEvidence.providerIdentity
			if (!providerIdentityEvidence) {
				throw new Error(
					`Eligible lifecycle event ${decision.sourceId} is missing provider identity evidence`,
				)
			}
			const identity = await args.repository.createProviderIdentity({
				contactId: decision.contactId,
				provider: providerIdentityEvidence.provider,
				externalId: providerIdentityEvidence.externalId,
				evidence: decision.wouldCreate.identityEvidence,
				createdAt: args.now,
				updatedAt: args.now,
			})
			providerIdentityId = identity.id
			createdProviderIdentities += 1
		}
		written.push(
			await args.repository.createContactEvent({
				...decision.wouldCreate,
				contactId: decision.contactId,
				providerIdentityId,
				createdAt: args.now,
			}),
		)
	}
	return { written, createdProviderIdentities }
}

export async function previewPurchaseRecordedContactEvents(args: {
	repository: ContactEventPreviewRepository
	rows: PurchaseRecordedSource[]
}): Promise<LifecycleContactEventSummary> {
	const decisions: LifecycleContactEventDecision[] = []
	for (const row of args.rows) {
		decisions.push(await previewPurchaseRecordedDecision(args.repository, row))
	}
	return summarize('preview', decisions, [], 0)
}

export async function writePurchaseRecordedContactEvents(args: {
	repository: ContactEventWriteRepository
	rows: PurchaseRecordedSource[]
	now?: string
}): Promise<LifecycleContactEventSummary> {
	const now = args.now ?? new Date().toISOString()
	const decisions: LifecycleContactEventDecision[] = []
	for (const row of args.rows) {
		decisions.push(await previewPurchaseRecordedDecision(args.repository, row))
	}
	const { written, createdProviderIdentities } = await writeLifecycleDecisions({
		repository: args.repository,
		decisions,
		now,
	})
	return summarize('write', decisions, written, createdProviderIdentities)
}

export async function previewContactUnsubscribedContactEvents(args: {
	repository: ContactEventPreviewRepository
	rows: ContactUnsubscribedSource[]
}): Promise<LifecycleContactEventSummary> {
	const decisions: LifecycleContactEventDecision[] = []
	for (const row of args.rows) {
		decisions.push(
			await previewContactUnsubscribedDecision(args.repository, row),
		)
	}
	return summarize('preview', decisions, [], 0)
}

export async function writeContactUnsubscribedContactEvents(args: {
	repository: ContactEventWriteRepository
	rows: ContactUnsubscribedSource[]
	now?: string
}): Promise<LifecycleContactEventSummary> {
	const now = args.now ?? new Date().toISOString()
	const decisions: LifecycleContactEventDecision[] = []
	for (const row of args.rows) {
		decisions.push(
			await previewContactUnsubscribedDecision(args.repository, row),
		)
	}
	const { written, createdProviderIdentities } = await writeLifecycleDecisions({
		repository: args.repository,
		decisions,
		now,
	})
	return summarize('write', decisions, written, createdProviderIdentities)
}
