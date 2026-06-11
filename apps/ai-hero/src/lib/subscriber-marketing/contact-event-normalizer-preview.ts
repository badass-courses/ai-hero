import {
	CONTACT_EVENT_SCHEMA_VERSION,
	type ContactEventRecord,
	type ContactIdentityEvidence,
	type ContactRecord,
	type NormalizedContactEvent,
	type PayloadSummary,
	type ProviderIdentityRecord,
} from './types'

export type ContactEventPreviewRepository = {
	findContactByEmail(
		email: string,
	): ContactRecord | undefined | Promise<ContactRecord | undefined>
	findContactById(
		id: string,
	): ContactRecord | undefined | Promise<ContactRecord | undefined>
	findContactByUserId(
		userId: string,
	): ContactRecord | undefined | Promise<ContactRecord | undefined>
	findProviderIdentity(
		provider: string,
		externalId: string,
	):
		| ProviderIdentityRecord
		| undefined
		| Promise<ProviderIdentityRecord | undefined>
	findContactEventBySemanticKey(
		key: string,
	): ContactEventRecord | undefined | Promise<ContactEventRecord | undefined>
}

export type KitSubscriberLookup = {
	getSubscriber: (id: string) =>
		| {
				id: number | string
				email_address?: string | null
				first_name?: string | null
		  }
		| null
		| undefined
		| Promise<
				| {
						id: number | string
						email_address?: string | null
						first_name?: string | null
				  }
				| null
				| undefined
		  >
}

export type ContactEventWriteRepository = ContactEventPreviewRepository & {
	createContact(
		input: Omit<ContactRecord, 'id'>,
	): ContactRecord | Promise<ContactRecord>
	createProviderIdentity(
		input: Omit<ProviderIdentityRecord, 'id'>,
	): ProviderIdentityRecord | Promise<ProviderIdentityRecord>
	createContactEvent(
		input: Omit<ContactEventRecord, 'id' | 'createdAt'> & {
			createdAt?: string
		},
	): ContactEventRecord | Promise<ContactEventRecord>
}

export type ContentReadContactEventSource = {
	id: string
	sessionId: string
	contactId?: string | null
	userId?: string | null
	kitSubscriberId?: string | null
	emailSha256?: string | null
	contentId: string
	contentSlug: string
	contentType: string
	parentSlug?: string | null
	readSignal: string
	sourceShortlinkSlug?: string | null
	shortlinkMetadata?: Record<string, unknown> | null
	firstTouch?: Record<string, unknown> | null
	contentMetadata?: Record<string, unknown> | null
	pathname: string
	semanticIdempotencyKey: string
	occurredAt: string | Date
}

export type ShortlinkClickContactEventSource = {
	id: string
	shortlinkId: string
	slug?: string | null
	url?: string | null
	timestamp: string | Date
	metadata?: Record<string, unknown> | null
	shortlinkMetadata?: Record<string, unknown> | null
}

export type ContactEventPreviewDecision =
	| {
			status: 'eligible'
			source: 'content-read' | 'shortlink-click'
			sourceId: string
			contactId: string
			providerIdentityId: string
			identityResolutionPath: string
			wouldCreate: NormalizedContactEvent
	  }
	| {
			status: 'skipped'
			source: 'content-read' | 'shortlink-click'
			sourceId: string
			reason:
				| 'anonymous-session-only'
				| 'email-hash-unresolved'
				| 'kit-subscriber-unresolved'
				| 'contact-not-found'
				| 'duplicate-semantic-key'
				| 'missing-trusted-identity'
			detail: string
	  }

export type ContactEventPreviewSummary = {
	mode: 'dry-run'
	eligibleCount: number
	skippedCount: number
	skippedByReason: Record<string, number>
	wouldCreate: Extract<ContactEventPreviewDecision, { status: 'eligible' }>[]
	samples: ContactEventPreviewDecision[]
	customerVisibleSideEffects: false
	kitWrites: false
	sequenceEnrollments: false
}

export type ContactEventWriteSummary = Omit<
	ContactEventPreviewSummary,
	'mode' | 'wouldCreate'
> & {
	mode: 'write'
	writtenCount: number
	written: ContactEventRecord[]
	writeSkippedCount: number
	contactStateWrites: false
}

export const CONTENT_READ_ALLOW_WRITE_SAFE_LIMIT = 10

export function validateContentReadAllowWriteOptions(args: {
	allowWrite: boolean
	limit?: number
	limitProvided: boolean
	forceLargeWrite?: boolean
}) {
	if (!args.allowWrite) return
	if (!args.limitProvided) {
		throw new Error(
			`content-read-event-preview --allow-write requires an explicit --limit no larger than ${CONTENT_READ_ALLOW_WRITE_SAFE_LIMIT}`,
		)
	}
	if (
		args.limit &&
		args.limit > CONTENT_READ_ALLOW_WRITE_SAFE_LIMIT &&
		!args.forceLargeWrite
	) {
		throw new Error(
			`content-read-event-preview --allow-write limit ${args.limit} is too large. Use --limit ${CONTENT_READ_ALLOW_WRITE_SAFE_LIMIT} or smaller, or pass --force-large-write for a reviewed backfill.`,
		)
	}
}

export async function previewContentReadContactEvents(args: {
	repository: ContactEventPreviewRepository
	rows: ContentReadContactEventSource[]
	sampleLimit?: number
}): Promise<ContactEventPreviewSummary> {
	const decisions = [] as ContactEventPreviewDecision[]
	for (const row of args.rows) {
		decisions.push(await previewContentReadContactEvent(args.repository, row))
	}
	return summarizeDecisions(decisions, args.sampleLimit)
}

export async function previewShortlinkClickContactEvents(args: {
	repository: ContactEventPreviewRepository
	rows: ShortlinkClickContactEventSource[]
	sampleLimit?: number
}): Promise<ContactEventPreviewSummary> {
	const decisions = [] as ContactEventPreviewDecision[]
	for (const row of args.rows) {
		decisions.push(
			await previewShortlinkClickContactEvent(args.repository, row),
		)
	}
	return summarizeDecisions(decisions, args.sampleLimit)
}

export async function writeContentReadContactEvents(args: {
	repository: ContactEventWriteRepository
	rows: ContentReadContactEventSource[]
	sampleLimit?: number
	now?: string
}): Promise<ContactEventWriteSummary> {
	const decisions = [] as ContactEventPreviewDecision[]
	const written = [] as ContactEventRecord[]
	const now = args.now ?? new Date().toISOString()
	for (const row of args.rows) {
		const decision = await previewContentReadContactEvent(args.repository, row)
		if (decision.status === 'eligible') {
			decisions.push(decision)
			const event = await args.repository.createContactEvent({
				...decision.wouldCreate,
				contactId: decision.contactId,
				providerIdentityId: decision.providerIdentityId,
				createdAt: now,
			})
			written.push(event)
			continue
		}
		const linked = await writeLoggedInUserContentRead({
			repository: args.repository,
			row,
			now,
		})
		if (linked) {
			decisions.push(linked.decision)
			written.push(linked.event)
			continue
		}
		decisions.push(decision)
	}
	return summarizeWrites(decisions, written, args.sampleLimit)
}

export async function linkAiHeroUserIdentities(args: {
	repository: ContactEventWriteRepository
	userIds: string[]
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const uniqueIds = Array.from(new Set(args.userIds.filter(Boolean)))
	const results: Array<
		| {
				status: 'linked'
				userId: string
				contactId: string
				providerIdentityId: string
				createdContact: boolean
				createdProviderIdentity: boolean
		  }
		| {
				status: 'skipped'
				userId: string
				reason: 'already-linked'
				detail: string
		  }
	> = []
	for (const userId of uniqueIds) {
		const existingIdentity = await args.repository.findProviderIdentity(
			'ai-hero',
			userId,
		)
		if (existingIdentity) {
			results.push({
				status: 'skipped',
				userId,
				reason: 'already-linked',
				detail: `AI Hero user ${userId} is already linked`,
			})
			continue
		}
		let contact = await args.repository.findContactByUserId(userId)
		let createdContact = false
		if (!contact) {
			contact = await args.repository.createContact({
				userId,
				email: null,
				name: null,
				lifecycle: 'new',
				isProvisional: true,
				createdAt: now,
				updatedAt: now,
			})
			createdContact = true
		}
		const providerIdentity = await args.repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: userId,
			evidence: {
				userId,
				providerIdentity: { provider: 'ai-hero', externalId: userId },
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: now,
			updatedAt: now,
		})
		results.push({
			status: 'linked',
			userId,
			contactId: contact.id,
			providerIdentityId: providerIdentity.id,
			createdContact,
			createdProviderIdentity: true,
		})
	}
	return {
		mode: 'write' as const,
		checkedCount: uniqueIds.length,
		linkedCount: results.filter((result) => result.status === 'linked').length,
		skippedCount: results.filter((result) => result.status === 'skipped')
			.length,
		results,
		kitWrites: false as const,
		sequenceEnrollments: false as const,
		customerVisibleSideEffects: false as const,
	}
}

export async function linkKitSubscriberIdentities(args: {
	repository: ContactEventWriteRepository
	kit: KitSubscriberLookup
	kitSubscriberIds: string[]
	now?: string
}) {
	const now = args.now ?? new Date().toISOString()
	const uniqueIds = Array.from(new Set(args.kitSubscriberIds.filter(Boolean)))
	const results: Array<
		| {
				status: 'linked'
				kitSubscriberId: string
				contactId: string
				providerIdentityId: string
				createdContact: boolean
				createdProviderIdentity: boolean
		  }
		| {
				status: 'skipped'
				kitSubscriberId: string
				reason:
					| 'already-linked'
					| 'subscriber-not-found'
					| 'subscriber-email-missing'
				detail: string
		  }
	> = []
	for (const kitSubscriberId of uniqueIds) {
		const existingIdentity = await args.repository.findProviderIdentity(
			'kit',
			kitSubscriberId,
		)
		if (existingIdentity) {
			results.push({
				status: 'skipped',
				kitSubscriberId,
				reason: 'already-linked',
				detail: `Kit subscriber ${kitSubscriberId} is already linked`,
			})
			continue
		}
		const subscriber = await args.kit.getSubscriber(kitSubscriberId)
		const email = normalizeEmail(subscriber?.email_address)
		if (!subscriber) {
			results.push({
				status: 'skipped',
				kitSubscriberId,
				reason: 'subscriber-not-found',
				detail: `Kit subscriber ${kitSubscriberId} was not found`,
			})
			continue
		}
		if (!email) {
			results.push({
				status: 'skipped',
				kitSubscriberId,
				reason: 'subscriber-email-missing',
				detail: `Kit subscriber ${kitSubscriberId} has no verified email`,
			})
			continue
		}
		let contact = await args.repository.findContactByEmail(email)
		let createdContact = false
		if (!contact) {
			contact = await args.repository.createContact({
				userId: null,
				email,
				name: subscriber.first_name ?? null,
				lifecycle: 'new',
				isProvisional: true,
				createdAt: now,
				updatedAt: now,
			})
			createdContact = true
		}
		const providerIdentity = await args.repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'kit',
			externalId: kitSubscriberId,
			evidence: {
				email,
				name: subscriber.first_name ?? undefined,
				providerIdentity: { provider: 'kit', externalId: kitSubscriberId },
				source: 'kit',
				strength: 'strong',
			},
			createdAt: now,
			updatedAt: now,
		})
		results.push({
			status: 'linked',
			kitSubscriberId,
			contactId: contact.id,
			providerIdentityId: providerIdentity.id,
			createdContact,
			createdProviderIdentity: true,
		})
	}
	return {
		mode: 'write' as const,
		checkedCount: uniqueIds.length,
		linkedCount: results.filter((result) => result.status === 'linked').length,
		skippedCount: results.filter((result) => result.status === 'skipped')
			.length,
		results,
		kitWrites: false as const,
		sequenceEnrollments: false as const,
		customerVisibleSideEffects: false as const,
	}
}

async function writeLoggedInUserContentRead(args: {
	repository: ContactEventWriteRepository
	row: ContentReadContactEventSource
	now: string
}) {
	if (!args.row.userId) return undefined
	let contact = await args.repository.findContactByUserId(args.row.userId)
	if (!contact) {
		contact = await args.repository.createContact({
			userId: args.row.userId,
			email: null,
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: args.now,
			updatedAt: args.now,
		})
	}
	let providerIdentity = await args.repository.findProviderIdentity(
		'ai-hero',
		args.row.userId,
	)
	if (!providerIdentity) {
		providerIdentity = await args.repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: args.row.userId,
			evidence: {
				userId: args.row.userId,
				providerIdentity: {
					provider: 'ai-hero',
					externalId: args.row.userId,
				},
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: args.now,
			updatedAt: args.now,
		})
	}
	const wouldCreate = buildContentReadEvent(args.row, {
		email: contact.email ?? undefined,
		name: contact.name ?? undefined,
		userId: args.row.userId,
		providerIdentity: { provider: 'ai-hero', externalId: args.row.userId },
		source: 'ai-hero',
		strength: 'strong',
	})
	const existing = await args.repository.findContactEventBySemanticKey(
		wouldCreate.semanticIdempotencyKey,
	)
	if (existing) return undefined
	const event = await args.repository.createContactEvent({
		...wouldCreate,
		contactId: contact.id,
		providerIdentityId: providerIdentity.id,
		createdAt: args.now,
	})
	return {
		decision: {
			status: 'eligible' as const,
			source: 'content-read' as const,
			sourceId: args.row.id,
			contactId: contact.id,
			providerIdentityId: providerIdentity.id,
			identityResolutionPath: 'logged-in-user-created-ai-hero-identity',
			wouldCreate,
		},
		event,
	}
}

export async function writeShortlinkClickContactEvents(args: {
	repository: ContactEventWriteRepository
	rows: ShortlinkClickContactEventSource[]
	sampleLimit?: number
	now?: string
}): Promise<ContactEventWriteSummary> {
	const decisions = [] as ContactEventPreviewDecision[]
	const written = [] as ContactEventRecord[]
	const now = args.now ?? new Date().toISOString()
	for (const row of args.rows) {
		const decision = await previewShortlinkClickContactEvent(
			args.repository,
			row,
		)
		decisions.push(decision)
		if (decision.status !== 'eligible') continue
		const event = await args.repository.createContactEvent({
			...decision.wouldCreate,
			contactId: decision.contactId,
			providerIdentityId: decision.providerIdentityId,
			createdAt: now,
		})
		written.push(event)
	}
	return summarizeWrites(decisions, written, args.sampleLimit)
}

export async function previewContentReadContactEvent(
	repository: ContactEventPreviewRepository,
	row: ContentReadContactEventSource,
): Promise<ContactEventPreviewDecision> {
	const resolved = await resolveConservativeIdentity(repository, {
		contactId: row.contactId,
		userId: row.userId,
		kitSubscriberId: row.kitSubscriberId,
		emailSha256: row.emailSha256,
	})
	if (resolved.status === 'skipped') {
		return { source: 'content-read', sourceId: row.id, ...resolved }
	}

	const event = buildContentReadEvent(row, resolved.evidence)
	const existing = await repository.findContactEventBySemanticKey(
		event.semanticIdempotencyKey,
	)
	if (existing) {
		return {
			status: 'skipped',
			source: 'content-read',
			sourceId: row.id,
			reason: 'duplicate-semantic-key',
			detail: `Contact Event already exists for ${event.semanticIdempotencyKey}`,
		}
	}

	return {
		status: 'eligible',
		source: 'content-read',
		sourceId: row.id,
		contactId: resolved.contact.id,
		providerIdentityId: resolved.providerIdentity.id,
		identityResolutionPath: resolved.path,
		wouldCreate: event,
	}
}

export async function previewShortlinkClickContactEvent(
	repository: ContactEventPreviewRepository,
	row: ShortlinkClickContactEventSource,
): Promise<ContactEventPreviewDecision> {
	const metadata = row.metadata ?? {}
	const resolved = await resolveConservativeIdentity(repository, {
		contactId: stringValue(metadata.contactId),
		userId: stringValue(metadata.userId),
		kitSubscriberId: stringValue(metadata.kitSubscriberId),
		emailSha256: stringValue(metadata.emailSha256),
	})
	if (resolved.status === 'skipped') {
		return { source: 'shortlink-click', sourceId: row.id, ...resolved }
	}

	const event = buildShortlinkClickEvent(row, resolved.evidence)
	const existing = await repository.findContactEventBySemanticKey(
		event.semanticIdempotencyKey,
	)
	if (existing) {
		return {
			status: 'skipped',
			source: 'shortlink-click',
			sourceId: row.id,
			reason: 'duplicate-semantic-key',
			detail: `Contact Event already exists for ${event.semanticIdempotencyKey}`,
		}
	}

	return {
		status: 'eligible',
		source: 'shortlink-click',
		sourceId: row.id,
		contactId: resolved.contact.id,
		providerIdentityId: resolved.providerIdentity.id,
		identityResolutionPath: resolved.path,
		wouldCreate: event,
	}
}

async function resolveConservativeIdentity(
	repository: ContactEventPreviewRepository,
	input: {
		contactId?: string | null
		userId?: string | null
		kitSubscriberId?: string | null
		emailSha256?: string | null
	},
): Promise<
	| {
			status: 'resolved'
			contact: ContactRecord
			providerIdentity: ProviderIdentityRecord
			evidence: ContactIdentityEvidence
			path: string
	  }
	| {
			status: 'skipped'
			reason: ContactEventPreviewDecision extends infer Decision
				? Decision extends { status: 'skipped'; reason: infer Reason }
					? Reason
					: never
				: never
			detail: string
	  }
> {
	if (input.contactId) {
		const contact = await repository.findContactById(input.contactId)
		if (!contact) {
			return {
				status: 'skipped',
				reason: 'contact-not-found',
				detail: `Content identity referenced missing Contact ${input.contactId}`,
			}
		}
		const externalId = contact.userId ?? contact.id
		const identity = await repository.findProviderIdentity(
			'ai-hero',
			externalId,
		)
		if (!identity) {
			return {
				status: 'skipped',
				reason: 'missing-trusted-identity',
				detail: `Contact ${contact.id} has no ai-hero provider identity for ${externalId}`,
			}
		}
		return {
			status: 'resolved',
			contact,
			providerIdentity: identity,
			evidence: {
				email: contact.email ?? undefined,
				name: contact.name ?? undefined,
				userId: contact.userId ?? undefined,
				providerIdentity: { provider: 'ai-hero', externalId },
				source: 'ai-hero',
				strength: 'strong',
			},
			path: contact.userId
				? 'contact-id-existing-ai-hero-user-identity'
				: 'contact-id-existing-ai-hero-contact-identity',
		}
	}

	if (input.userId) {
		const identity = await repository.findProviderIdentity(
			'ai-hero',
			input.userId,
		)
		const contact = identity
			? await repository.findContactById(identity.contactId)
			: await repository.findContactByUserId(input.userId)
		if (!identity || !contact) {
			return {
				status: 'skipped',
				reason: 'missing-trusted-identity',
				detail: `Logged-in user ${input.userId} has no existing ai-hero Contact/provider identity`,
			}
		}
		return {
			status: 'resolved',
			contact,
			providerIdentity: identity,
			evidence: {
				email: contact.email ?? undefined,
				name: contact.name ?? undefined,
				userId: input.userId,
				providerIdentity: { provider: 'ai-hero', externalId: input.userId },
				source: 'ai-hero',
				strength: 'strong',
			},
			path: 'logged-in-user-existing-ai-hero-provider-identity',
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
		if (!identity || !contact) {
			return {
				status: 'skipped',
				reason: 'kit-subscriber-unresolved',
				detail: `Kit subscriber ${input.kitSubscriberId} is not linked to an existing Contact`,
			}
		}
		return {
			status: 'resolved',
			contact,
			providerIdentity: identity,
			evidence: {
				email: contact.email ?? undefined,
				name: contact.name ?? undefined,
				userId: contact.userId ?? undefined,
				providerIdentity: {
					provider: 'kit',
					externalId: input.kitSubscriberId,
				},
				source: 'kit',
				strength: 'strong',
			},
			path: 'kit-subscriber-existing-provider-identity',
		}
	}

	if (input.emailSha256) {
		return {
			status: 'skipped',
			reason: 'email-hash-unresolved',
			detail:
				'Email hash was present but is not normalized without an existing trusted identity match.',
		}
	}

	return {
		status: 'skipped',
		reason: 'anonymous-session-only',
		detail: 'Only anonymous session or attribution cookies were present.',
	}
}

function buildContentReadEvent(
	row: ContentReadContactEventSource,
	evidence: ContactIdentityEvidence,
): NormalizedContactEvent {
	const contentTitle = stringValue(row.contentMetadata?.title)
	const keywords = compactStrings([
		'content-read',
		row.contentType,
		row.readSignal,
		row.contentSlug,
		row.sourceShortlinkSlug,
	])
	return {
		provider: 'ai-hero',
		providerEventId: `content-read:${row.id}`,
		providerReference: `ai-hero:content-read:${row.id}`,
		eventType: 'content.read',
		occurredAt: toIso(row.occurredAt),
		semanticIdempotencyKey:
			`ai-hero:content.read:${row.semanticIdempotencyKey}`.toLowerCase(),
		privacyLevel: 'internal',
		identityEvidence: evidence,
		payloadSummary: {
			summary: compactStrings([
				`Read signal ${row.readSignal}`,
				contentTitle
					? `for ${contentTitle}`
					: `for ${row.contentType} ${row.contentSlug}`,
				row.sourceShortlinkSlug
					? `from shortlink ${row.sourceShortlinkSlug}`
					: undefined,
			]).join(' '),
			keywords,
			restrictedPayloadStored: false,
		},
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
	}
}

function buildShortlinkClickEvent(
	row: ShortlinkClickContactEventSource,
	evidence: ContactIdentityEvidence,
): NormalizedContactEvent {
	const metadata = { ...(row.shortlinkMetadata ?? {}), ...(row.metadata ?? {}) }
	const campaign =
		stringValue(metadata.campaign) ??
		stringValue(metadata.campaignId) ??
		stringValue(metadata.campaignSlug)
	const contentSlug =
		stringValue(metadata.contentSlug) ?? stringValue(metadata.resourceSlug)
	const source =
		stringValue(metadata.source) ?? stringValue(metadata.utm_source)
	const keywords = compactStrings([
		'shortlink-click',
		row.slug,
		campaign,
		contentSlug,
		source,
	])
	return {
		provider: 'ai-hero',
		providerEventId: `shortlink-click:${row.id}`,
		providerReference: `ai-hero:shortlink-click:${row.id}`,
		eventType: 'shortlink.click',
		occurredAt: toIso(row.timestamp),
		semanticIdempotencyKey: `ai-hero:shortlink.click:${row.id}`.toLowerCase(),
		privacyLevel: 'internal',
		identityEvidence: evidence,
		payloadSummary: summarizeShortlinkClick(
			row,
			campaign,
			contentSlug,
			source,
			keywords,
		),
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
	}
}

function summarizeShortlinkClick(
	row: ShortlinkClickContactEventSource,
	campaign: string | undefined,
	contentSlug: string | undefined,
	source: string | undefined,
	keywords: string[],
): PayloadSummary {
	return {
		summary: compactStrings([
			`Clicked shortlink ${row.slug ?? row.shortlinkId}`,
			campaign ? `campaign ${campaign}` : undefined,
			contentSlug ? `content ${contentSlug}` : undefined,
			source ? `source ${source}` : undefined,
		]).join('; '),
		keywords,
		restrictedPayloadStored: false,
	}
}

function summarizeDecisions(
	decisions: ContactEventPreviewDecision[],
	sampleLimit = 10,
): ContactEventPreviewSummary {
	const { wouldCreate, skipped, skippedByReason } =
		partitionDecisions(decisions)
	return {
		mode: 'dry-run',
		eligibleCount: wouldCreate.length,
		skippedCount: skipped.length,
		skippedByReason,
		wouldCreate,
		samples: decisions.slice(0, sampleLimit),
		customerVisibleSideEffects: false,
		kitWrites: false,
		sequenceEnrollments: false,
	}
}

function summarizeWrites(
	decisions: ContactEventPreviewDecision[],
	written: ContactEventRecord[],
	sampleLimit = 10,
): ContactEventWriteSummary {
	const { wouldCreate, skipped, skippedByReason } =
		partitionDecisions(decisions)
	return {
		mode: 'write',
		eligibleCount: wouldCreate.length,
		skippedCount: skipped.length,
		skippedByReason,
		samples: decisions.slice(0, sampleLimit),
		writtenCount: written.length,
		written,
		writeSkippedCount: wouldCreate.length - written.length,
		customerVisibleSideEffects: false,
		kitWrites: false,
		sequenceEnrollments: false,
		contactStateWrites: false,
	}
}

function partitionDecisions(decisions: ContactEventPreviewDecision[]) {
	const wouldCreate = decisions.filter(
		(
			decision,
		): decision is Extract<
			ContactEventPreviewDecision,
			{ status: 'eligible' }
		> => decision.status === 'eligible',
	)
	const skipped = decisions.filter(
		(
			decision,
		): decision is Extract<
			ContactEventPreviewDecision,
			{ status: 'skipped' }
		> => decision.status === 'skipped',
	)
	const skippedByReason = skipped.reduce<Record<string, number>>(
		(counts, decision) => {
			counts[decision.reason] = (counts[decision.reason] ?? 0) + 1
			return counts
		},
		{},
	)
	return { wouldCreate, skipped, skippedByReason }
}

function normalizeEmail(value?: string | null) {
	const email = value?.trim().toLowerCase()
	return email && email.includes('@') ? email : undefined
}

function stringValue(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function compactStrings(values: Array<string | null | undefined>) {
	return values.filter((value): value is string => Boolean(value))
}

function toIso(value: string | Date) {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString()
}
