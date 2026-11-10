import 'server-only'

import { cache } from 'react'
import { env } from '@/env.mjs'
import { SubscriberSchema, type Subscriber } from '@/schemas/subscriber'
import {
	readDrovrListState,
	type DrovrListState,
} from '@/lib/subscriber-marketing/drovr-list-state'
import { parseDrovrSignupDeliveryConfig } from '@/lib/subscriber-marketing/drovr-doi-signup'

export function gatedAsksOffKitEnabled() {
	return env.AIH_GATED_ASKS_OFF_KIT_ENABLED === 'true'
}

export type OffKitAskEvidence = {
	subscriber: Subscriber | null
	list: DrovrListState | null
	courseStarted: boolean
}

export const GATED_ASK_LIST_TTL_MS = 60_000
export const GATED_ASK_LIST_CACHE_MAX = 2000

type CachedList = { list: DrovrListState; expires: number }
const listCache = new Map<string, CachedList>()

export function resetGatedAskListCache() {
	listCache.clear()
}

/** Only decisive answers are cached; unavailable (null) and the rest never are. */
function cacheable(list: DrovrListState | null): list is DrovrListState {
	if (!list) return false
	return (
		list.state === 'confirmed' ||
		list.state === 'stopped' ||
		(list.state === 'unknown' && list.unknownReason === 'no-consent-evidence')
	)
}

/**
 * Per-instance, 60s, size-bounded cache for the page-render ask read only.
 * Send, enrolment and resubscribe decisions use the fresh read instead.
 */
async function readListStateCached(contactId: string) {
	const now = Date.now()
	const hit = listCache.get(contactId)
	if (hit && hit.expires > now) {
		listCache.delete(contactId)
		listCache.set(contactId, hit) // LRU touch
		return hit.list
	}
	listCache.delete(contactId)
	const list = await readDrovrListState(
		{ contactId },
		parseDrovrSignupDeliveryConfig(env),
	)
	if (cacheable(list)) {
		listCache.set(contactId, { list, expires: now + GATED_ASK_LIST_TTL_MS })
		while (listCache.size > GATED_ASK_LIST_CACHE_MAX) {
			listCache.delete(listCache.keys().next().value as string)
		}
	}
	return list
}

/** No cookie state/custom fields are consent or course-entry evidence. */
export const readGatedAskForEmail = cache((email: string) =>
	loadGatedAsk(email, readListStateCached),
)

/** Uncached by TTL: decisions that act on the answer (resubscribe/DOI) read drovr fresh. */
export const readGatedAskForEmailFresh = cache((email: string) =>
	loadGatedAsk(email, (contactId) =>
		readDrovrListState({ contactId }, parseDrovrSignupDeliveryConfig(env)),
	),
)

async function loadGatedAsk(
	email: string,
	readList: (contactId: string) => Promise<DrovrListState | null>,
): Promise<OffKitAskEvidence> {
	{
		return boundedRead(async () => {
			const [{ db }, { contact, contactEvent }, { and, eq }, store] =
				await Promise.all([
					import('@/db'),
					import('@/db/schema'),
					import('drizzle-orm'),
					import('@/lib/cta/interest-fact-store'),
				])
			const contactId = await store.findContactIdForEmail(db, email)
			if (!contactId) return unknownEvidence(email)
			const [row, list, fields, entries] = await Promise.all([
				db.query.contact.findFirst({
					where: eq(contact.id, contactId),
					columns: { email: true, name: true },
				}),
				readList(contactId),
				store.readLocalInterestFields(db, contactId).catch(() => ({})),
				db
					.select({ occurredAt: contactEvent.occurredAt })
					.from(contactEvent)
					.where(
						and(
							eq(contactEvent.contactId, contactId),
							eq(contactEvent.eventType, 'value-path.entered'),
							eq(
								contactEvent.providerReference,
								'value-path:ai-hero-skills-workflow',
							),
						),
					)
					.limit(1)
					.catch(() => []),
			])
			const started = entries[0]?.occurredAt
			const courseStarted = Boolean(
				started && Number.isFinite(new Date(started).getTime()),
			)
			return {
				list,
				courseStarted,
				subscriber: SubscriberSchema.parse({
					id: 0,
					email_address: row?.email ?? email,
					first_name: row?.name ?? undefined,
					state: list?.state === 'confirmed' ? 'active' : undefined,
					fields: {
						...fields,
						...(courseStarted
							? { aih_course_started_at: new Date(started!).toISOString() }
							: {}),
					},
				}),
			}
		}, email)
	}
}

/** Cookie ids name identities only; all decisions are freshly read above. */
export const readOffKitGatingEvidence = cache(
	async (options?: {
		sessionOnly?: boolean
		sessionEmail?: string | null
	}): Promise<OffKitAskEvidence> => {
		try {
			const { getServerAuthSession } = await import('@/server/auth')
			const auth = await getServerAuthSession().catch(() => null)
			const sessionEmail = options?.sessionEmail ?? auth?.session?.user?.email
			if (sessionEmail) return readGatedAskForEmail(sessionEmail)
			// The public CTA endpoint must not become a directory/list-state oracle
			// driven by a forged cookie id. Only its authenticated session may read.
			if (options?.sessionOnly) return unknownEvidence()
			return boundedRead(async () => {
				const [{ cookies }, directory, gate] = await Promise.all([
					import('next/headers'),
					import('@/lib/kit-subscriber-directory'),
					import('@/lib/cta/subscriber-gate-cookie'),
				])
				const jar = await cookies()
				const snapshot = gate.parseSubscriberGateSnapshot(
					jar?.get(gate.SUBSCRIBER_GATE_COOKIE)?.value,
				)
				let id: unknown = jar?.get('ck_subscriber_id')?.value ?? snapshot?.id
				if (!id) {
					try {
						id = JSON.parse(jar?.get('ck_subscriber')?.value ?? 'null')?.id
					} catch {}
				}
				const identity = await directory.readKitSubscriberIdentity(id)
				return identity
					? readGatedAskForEmail(identity.email_address)
					: unknownEvidence()
			})
		} catch {
			return unknownEvidence()
		}
	},
)

function unknownEvidence(email?: string): OffKitAskEvidence {
	return {
		subscriber: email
			? SubscriberSchema.parse({ id: 0, email_address: email, fields: {} })
			: null,
		list: null,
		courseStarted: false,
	}
}

async function boundedRead(
	read: () => Promise<OffKitAskEvidence>,
	email?: string,
): Promise<OffKitAskEvidence> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			read(),
			new Promise<OffKitAskEvidence>((resolve) => {
				timer = setTimeout(() => resolve(unknownEvidence(email)), 2000)
			}),
		])
	} catch {
		return unknownEvidence(email)
	} finally {
		clearTimeout(timer)
	}
}
