import { INCLUDED_PRODUCTS } from './included-product-policy'
import type { DrovrContactResolution } from './subscriber-marketing/drovr-purchase-resolve'
import type { DrovrShadowEvent } from './subscriber-marketing/drovr-shadow-emitter'
import type { ContactEventWriteRepository } from './subscriber-marketing/contact-event-normalizer-preview'
import type { EntitlementRecordedSource } from './subscriber-marketing/lifecycle-contact-events'

/**
 * Included-product grants told to drovr as ownership: `entitlement.granted`
 * for a live grant and `entitlement.revoked` for one that ended, on the user
 * who holds or held it. drovr's offer engine reads them so a C5 seat holder
 * is never pitched the crash course the seat includes.
 *
 * Facts are derived from the rows' current state, never from the operation
 * that changed them: the grant path, the transfer path and the backfill all
 * read the purchase's rows and record what is true now. Each grant has its
 * own id (the row id, or `<row id>:<transferId>` once a transfer restored
 * it), because drovr ends a grant id for good at its first revoke.
 */

/** The one reader of AIH_ENTITLEMENT_EVENTS_ENABLED. Default off. */
export function entitlementEventsEnabled(
	source: Record<string, string | undefined> = process.env,
): boolean {
	return ['on', 'true', '1'].includes(
		(source.AIH_ENTITLEMENT_EVENTS_ENABLED ?? '').trim().toLowerCase(),
	)
}

export type IncludedEntitlementRow = {
	id: string
	userId: string | null
	metadata?: Record<string, unknown> | null
	createdAt?: Date | string | null
	deletedAt?: Date | string | null
}

export type IncludedEntitlementFact = Omit<
	EntitlementRecordedSource,
	'email' | 'name' | 'userId'
> & { userId: string }

const isoOf = (value: Date | string | null | undefined, fallback: string) => {
	if (!value) return fallback
	const at = new Date(value)
	return Number.isNaN(at.getTime()) ? fallback : at.toISOString()
}

const textOf = (value: unknown) =>
	typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * The content-access rows an included-product policy wrote (never the
 * Discord rows, which carry no contentIds), as grant facts.
 */
export function includedEntitlementFacts(
	rows: readonly IncludedEntitlementRow[],
	now = new Date().toISOString(),
): IncludedEntitlementFact[] {
	const facts: IncludedEntitlementFact[] = []
	for (const row of rows) {
		const viaProductId = textOf(row.metadata?.includedByProductId)
		const contentIds = row.metadata?.contentIds
		const policy = viaProductId
			? INCLUDED_PRODUCTS[viaProductId]?.find(
					(candidate) =>
						row.id.startsWith(candidate.idPrefix) &&
						row.metadata?.bundlePolicy === candidate.bundlePolicy &&
						Array.isArray(contentIds) &&
						contentIds.length === 1 &&
						contentIds[0] === candidate.workshopId,
				)
			: undefined
		if (!policy || !viaProductId || !row.userId) continue
		const common = {
			userId: row.userId,
			productId: policy.productId,
			viaProductId,
			bundlePolicy: policy.bundlePolicy,
		}
		const restoredBy = textOf(row.metadata?.restoredByTransferId)
		const restoredAt = isoOf(textOf(row.metadata?.restoredAt), now)
		// A restored row's first grant ended when a transfer retired it. The
		// live retire recorded that already; this repairs a missed one.
		if (restoredBy)
			facts.push({
				...common,
				change: 'revoked',
				entitlementId: row.id,
				occurredAt: restoredAt,
			})
		const entitlementId = restoredBy ? `${row.id}:${restoredBy}` : row.id
		facts.push(
			row.deletedAt
				? {
						...common,
						change: 'revoked',
						entitlementId,
						occurredAt: isoOf(row.deletedAt, now),
					}
				: {
						...common,
						change: 'granted',
						entitlementId,
						occurredAt: restoredBy ? restoredAt : isoOf(row.createdAt, now),
					},
		)
	}
	return facts
}

/**
 * The authority events for a holder drovr knows but ai-hero has no contact
 * for, under the same idempotency key the ContactEvent mirror uses
 * (`aihero:ai-hero:entitlement.<change>:<entitlementId>`).
 */
export async function drovrEntitlementEventsFor(
	source: EntitlementRecordedSource,
	drovrContactId: string,
): Promise<DrovrShadowEvent[]> {
	const [{ buildEntitlementRecordedEvent }, emitter] = await Promise.all([
		import('./subscriber-marketing/lifecycle-contact-events'),
		import('./subscriber-marketing/drovr-shadow-emitter'),
	])
	const normalized = buildEntitlementRecordedEvent(source, {
		source: 'ai-hero',
		strength: 'strong',
	})
	return emitter
		.mapDrovrShadowFact({
			kind: 'contact-event',
			event: {
				...normalized,
				id: `drovr-resolved:${source.entitlementId}:${source.change}`,
				contactId: drovrContactId,
				providerIdentityId: '',
				createdAt: source.occurredAt,
			},
		})
		.filter((event) => event.tenantId === emitter.DROVR_AUTHORITY_TENANT_ID)
}

export type EntitlementEventPorts = {
	readRows: (purchaseId: string) => Promise<IncludedEntitlementRow[]>
	readUsers: (
		userIds: readonly string[],
	) => Promise<Map<string, { email: string | null; name: string | null }>>
	repository: () => Promise<ContactEventWriteRepository>
	/** drovr's resolve and post, or undefined when drovr is not configured. */
	drovr: () => Promise<
		| {
				resolve: (
					emails: readonly string[],
				) => Promise<Map<string, DrovrContactResolution>>
				deliver: (
					events: readonly DrovrShadowEvent[],
				) => Promise<{ accepted: number; rejected: number }>
		  }
		| undefined
	>
	now: () => string
}

export type EntitlementEventsResult =
	| { status: 'disabled' }
	| {
			status: 'recorded'
			facts: number
			written: number
			skippedByReason: Record<string, number>
			drovr: { resolved: number; accepted: number; rejected: number }
	  }

// Lazy: the database, drovr and ContactEvent modules stay off the import
// path of fulfilment until the flag is on.
const livePorts: EntitlementEventPorts = {
	readRows: async (purchaseId) => {
		const [{ db }, { entitlements }, { and, eq }] = await Promise.all([
			import('@/db'),
			import('@/db/schema'),
			import('drizzle-orm'),
		])
		const { EntitlementSourceType } = await import('./entitlement-source-type')
		return db.query.entitlements.findMany({
			where: and(
				eq(entitlements.sourceId, purchaseId),
				eq(entitlements.sourceType, EntitlementSourceType.PURCHASE),
			),
		})
	},
	readUsers: async (userIds) => {
		const [{ db }, { users }, { inArray }] = await Promise.all([
			import('@/db'),
			import('@/db/schema'),
			import('drizzle-orm'),
		])
		if (userIds.length === 0) return new Map()
		const found = await db.query.users.findMany({
			where: inArray(users.id, [...userIds]),
			columns: { id: true, email: true, name: true },
		})
		return new Map(
			found.map((user) => [
				user.id,
				{ email: user.email ?? null, name: user.name ?? null },
			]),
		)
	},
	repository: async () => {
		const [{ db }, { DrizzleCaptureMarketingRepository }] = await Promise.all([
			import('@/db'),
			import('./subscriber-marketing/drizzle-capture-repository'),
		])
		return new DrizzleCaptureMarketingRepository(db)
	},
	drovr: async () => {
		const [{ env }, emitter, resolver, page] = await Promise.all([
			import('@/env.mjs'),
			import('./subscriber-marketing/drovr-shadow-emitter'),
			import('./subscriber-marketing/drovr-purchase-resolve'),
			import('./subscriber-marketing/drovr-unsubscribe-page'),
		])
		const ingestUrl = env.DROVR_SHADOW_INGEST_URL
		const apiKey = emitter.drovrApiKeyForTenant(
			emitter.DROVR_AUTHORITY_TENANT_ID,
		)
		const baseUrl = page.resolveDrovrApiBaseUrl({
			DROVR_API_BASE_URL: env.DROVR_API_BASE_URL,
			DROVR_SHADOW_INGEST_URL: ingestUrl,
		})
		if (!ingestUrl || !apiKey || !baseUrl) return undefined
		return {
			resolve: (emails) =>
				resolver.resolveDrovrContacts({ emails, config: { baseUrl, apiKey } }),
			deliver: (events) =>
				resolver.deliverResolvedPurchaseEvents({
					events,
					config: { ingestUrl, apiKey },
				}),
		}
	},
	now: () => new Date().toISOString(),
}

/**
 * Record what a purchase's included grants are now. A holder with an
 * ai-hero contact gets ContactEvents, whose awaited dispatch and outbox own
 * delivery. A holder drovr knows only by email is resolved there and
 * posted directly, as an uncontacted buyer's purchase is.
 */
export async function recordIncludedProductEntitlementEvents(args: {
	purchaseId: string
	enabled?: boolean
	ports?: Partial<EntitlementEventPorts>
}): Promise<EntitlementEventsResult> {
	if (!(args.enabled ?? entitlementEventsEnabled())) return { status: 'disabled' }
	const ports = { ...livePorts, ...args.ports }
	const now = ports.now()
	const facts = includedEntitlementFacts(await ports.readRows(args.purchaseId), now)
	const drovr = { resolved: 0, accepted: 0, rejected: 0 }
	if (facts.length === 0)
		return { status: 'recorded', facts: 0, written: 0, skippedByReason: {}, drovr }
	const people = await ports.readUsers([
		...new Set(facts.map((fact) => fact.userId)),
	])
	const sources: EntitlementRecordedSource[] = facts.map((fact) => ({
		...fact,
		email: people.get(fact.userId)?.email ?? null,
		name: people.get(fact.userId)?.name ?? null,
	}))
	const { writeEntitlementRecordedContactEvents } = await import(
		'./subscriber-marketing/lifecycle-contact-events'
	)
	const summary = await writeEntitlementRecordedContactEvents({
		repository: await ports.repository(),
		rows: sources,
		now,
	})
	const uncontacted = sources.filter((source) =>
		summary.decisions.some(
			(decision) =>
				decision.status === 'skipped' &&
				decision.reason === 'no-existing-contact' &&
				decision.sourceId === `${source.entitlementId}:${source.change}`,
		),
	)
	const emailOf = (source: EntitlementRecordedSource) =>
		source.email?.trim().toLowerCase()
	const reachable = uncontacted.filter((source) => emailOf(source))
	const client = reachable.length ? await ports.drovr() : undefined
	if (client) {
		const answers = await client.resolve(
			reachable.map((source) => emailOf(source)!),
		)
		for (const source of reachable) {
			const answer = answers.get(emailOf(source)!)
			if (answer?.status !== 'resolved') continue
			drovr.resolved += 1
			const result = await client.deliver(
				await drovrEntitlementEventsFor(source, answer.contactId),
			)
			drovr.accepted += result.accepted
			drovr.rejected += result.rejected
		}
	}
	return {
		status: 'recorded',
		facts: facts.length,
		written: summary.counts.written,
		skippedByReason: summary.counts.skippedByReason,
		drovr,
	}
}

/**
 * The grant and transfer paths call this after their transaction commits.
 * Recording is telemetry for drovr: a failure is logged and never reaches
 * fulfilment. The next reconcile of the purchase, or the backfill, records
 * what this one missed.
 */
export async function recordIncludedProductEntitlementEventsSafely(
	purchaseId: string,
	options: Omit<
		Parameters<typeof recordIncludedProductEntitlementEvents>[0],
		'purchaseId'
	> & { warn?: (event: string, data: Record<string, unknown>) => unknown } = {},
): Promise<EntitlementEventsResult | undefined> {
	try {
		return await recordIncludedProductEntitlementEvents({
			purchaseId,
			...options,
		})
	} catch (error) {
		try {
			const warn =
				options.warn ?? (await import('@/server/logger')).log.warn
			await warn('included_product.entitlement_events_failed', {
				purchaseId,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot fail fulfilment either.
		}
		return undefined
	}
}
