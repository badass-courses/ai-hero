import { readUnsubscribedValuePathContactIds } from './drovr-value-path-birth-admission-live'
import type { db as liveDatabase } from '@/db'
import { contactEvent, sideEffectIntent } from '@/db/schema'
import { and, asc, eq, gt, gte, inArray, like, lte, or } from 'drizzle-orm'

import {
	activeContactStopsByKey,
	CONTACT_STOP_RULE_EVENT_TYPES,
	isContactStopped,
	stopSignalOfEvent,
} from './contact-stop-rule'
import {
	toContactEventRecord,
	toSideEffectIntentRecord,
} from './drizzle-capture-repository'
import { SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE } from './drovr-evergreen'
import {
	fanOutOwnedEvents,
	isShadowNewsletterBirth,
	JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
	journeyOwnerProviderEventId,
} from './drovr-ownership'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	mapDrovrShadowFact,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import {
	OWNER_BIRTH_GUARD_OWNER_JOURNEY_IDS,
	type OwnerBirthGuardPorts,
	type OwnerBirthSubject,
	type RepostOutcome,
} from './owner-birth-guard'
import type { SideEffectIntent } from './types'

/**
 * The newsletter birth the live dispatch sent for a completed
 * shadow-newsletter list intent of a newsletter-owned contact: the owner
 * copy of the mapped birth (same key, same zone).
 */
export function newsletterOwnerBirthOf(
	intent: SideEffectIntent,
): DrovrShadowEvent | undefined {
	const births = mapDrovrShadowFact({
		kind: 'side-effect-intent-completed',
		intent,
	}).filter(isShadowNewsletterBirth)
	return fanOutOwnedEvents(births, new Set(), new Set([intent.contactId])).find(
		(event) =>
			event.tenantId === DROVR_AUTHORITY_TENANT_ID &&
			event.journeyId === DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	)
}
import type { ContactEventRecord } from './types'

/**
 * The guard's durable memory: one ContactEvent per owner whose birth it
 * re-posted, keyed by the owner event, so a key is re-posted at most once
 * ever. It maps to no drovr event.
 */
export const OWNER_BIRTH_REPOSTED_EVENT_TYPE = 'drovr.owner-birth.reposted'

export const ownerBirthRepostProviderEventId = (ownerEventId: string) =>
	`drovr-owner-birth-repost:${ownerEventId}`

export function ownerBirthRepostMarker(
	owner: ContactEventRecord,
	outcome: RepostOutcome,
	at: string,
): Omit<ContactEventRecord, 'id' | 'createdAt'> {
	const providerEventId = ownerBirthRepostProviderEventId(owner.id)
	return {
		contactId: owner.contactId,
		providerIdentityId: owner.providerIdentityId,
		provider: owner.provider,
		providerEventId,
		providerReference: owner.providerReference,
		eventType: OWNER_BIRTH_REPOSTED_EVENT_TYPE,
		occurredAt: at,
		semanticIdempotencyKey: providerEventId,
		privacyLevel: 'internal',
		identityEvidence: owner.identityEvidence,
		payloadSummary: {
			summary: `The owner-without-birth guard re-posted ${owner.id}'s birth: ${outcome}`,
			keywords: [outcome],
			restrictedPayloadStored: false,
		},
		schemaVersion: owner.schemaVersion,
	}
}

type Select = {
	select: (fields?: unknown) => {
		from: (table: unknown) => {
			where: (clause: unknown) => {
				orderBy: (...order: unknown[]) => {
					limit: (n: number) => Promise<unknown[]>
				}
			} & Promise<unknown[]>
		}
	}
}

/**
 * The guard's reads. The owner scan rides
 * ContactEvent_eventType_occurredAt_id_idx and pages by (occurredAt, id);
 * the stop and marker reads ride ContactEvent_contactId_idx.
 */
export function createDrizzleOwnerBirthGuardStore(
	// The same shape the capture repository takes; this only selects.
	database: unknown,
): Pick<
	OwnerBirthGuardPorts,
	| 'scanOwners'
	| 'scanNewsletterBirths'
	| 'stoppedContactIds'
	| 'unsubscribedValuePathContactIds'
	| 'repostedOwnerEventIds'
> {
	const db = database as Select
	return {
		async scanOwners({ from, to, after, limit }) {
			const cursor = after ? new Date(after.occurredAt) : undefined
			const rows = await db
				.select()
				.from(contactEvent)
				.where(
					and(
						eq(contactEvent.eventType, JOURNEY_OWNER_ASSIGNED_EVENT_TYPE),
						gte(contactEvent.occurredAt, new Date(from)),
						lte(contactEvent.occurredAt, new Date(to)),
						cursor && after
							? or(
									gt(contactEvent.occurredAt, cursor),
									and(
										eq(contactEvent.occurredAt, cursor),
										gt(contactEvent.id, after.id),
									),
								)
							: undefined,
						or(
							...OWNER_BIRTH_GUARD_OWNER_JOURNEY_IDS.map((journeyId) =>
								like(contactEvent.providerEventId, `%:${journeyId}`),
							),
						),
					),
				)
				.orderBy(asc(contactEvent.occurredAt), asc(contactEvent.id))
				.limit(limit)
			return rows.map(toContactEventRecord)
		},
		// Rides SideEffectIntent_provider_type_status_idx; the intents carry
		// the zone the birth was built with.
		async scanNewsletterBirths({ from, to, after, limit }) {
			const cursor = after ? new Date(after.occurredAt) : undefined
			const rows = (await db
				.select()
				.from(sideEffectIntent)
				.where(
					and(
						eq(sideEffectIntent.provider, 'kit'),
						eq(sideEffectIntent.type, SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE),
						eq(sideEffectIntent.status, 'completed'),
						gte(sideEffectIntent.completedAt, new Date(from)),
						lte(sideEffectIntent.completedAt, new Date(to)),
						cursor && after
							? or(
									gt(sideEffectIntent.completedAt, cursor),
									and(
										eq(sideEffectIntent.completedAt, cursor),
										gt(sideEffectIntent.id, after.id),
									),
								)
							: undefined,
					),
				)
				.orderBy(asc(sideEffectIntent.completedAt), asc(sideEffectIntent.id))
				.limit(limit)) as unknown[]
			const intents = rows.map(toSideEffectIntentRecord)
			const last = intents.at(-1)
			const next =
				rows.length === limit && last?.completedAt
					? { occurredAt: last.completedAt, id: last.id }
					: undefined
			const withBirth = intents
				.map((intent) => ({ intent, birth: newsletterOwnerBirthOf(intent) }))
				.filter(
					(
						item,
					): item is { intent: SideEffectIntent; birth: DrovrShadowEvent } =>
						item.birth !== undefined,
				)
			if (withBirth.length === 0)
				return { subjects: [], ...(next ? { next } : {}) }
			// Only newsletter-owned contacts have an authority birth at all.
			const owners = (
				await db
					.select()
					.from(contactEvent)
					.where(
						and(
							eq(contactEvent.eventType, JOURNEY_OWNER_ASSIGNED_EVENT_TYPE),
							inArray(
								contactEvent.providerEventId,
								withBirth.map(({ intent }) =>
									journeyOwnerProviderEventId(
										intent.contactId,
										DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
									),
								),
							),
						),
					)
			).map(toContactEventRecord)
			const ownerByContact = new Map(
				owners.map((owner) => [owner.contactId, owner]),
			)
			const subjects: OwnerBirthSubject[] = []
			const seen = new Set<string>()
			for (const { intent, birth } of withBirth) {
				const owner = ownerByContact.get(intent.contactId)
				// One newsletter birth per contact, whatever intent repeats it.
				if (!owner || seen.has(owner.id)) continue
				seen.add(owner.id)
				subjects.push({
					owner,
					journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
					birth,
				})
			}
			return { subjects, ...(next ? { next } : {}) }
		},
		async unsubscribedValuePathContactIds(contactIds) {
			// SAFETY: the caller supplies the same Drizzle db used by all reads here.
			return new Set(
				await readUnsubscribedValuePathContactIds(
					contactIds,
					database as Pick<typeof liveDatabase, 'select'>,
				),
			)
		},
		async stoppedContactIds(contactIds) {
			if (contactIds.length === 0) return new Set()
			const rows = (await db
				.select({
					contactId: contactEvent.contactId,
					eventType: contactEvent.eventType,
					occurredAt: contactEvent.occurredAt,
				})
				.from(contactEvent)
				.where(
					and(
						inArray(contactEvent.contactId, [...contactIds]),
						inArray(contactEvent.eventType, [...CONTACT_STOP_RULE_EVENT_TYPES]),
					),
				)) as { contactId: string; eventType: string; occurredAt: Date }[]
			// A fresh double opt-in lifts an unsubscribe (contact-stop-rule).
			const stops = activeContactStopsByKey(
				rows.map((row) => ({
					key: row.contactId,
					signal: stopSignalOfEvent(row),
				})),
			)
			return new Set(
				[...stops]
					.filter(([, active]) => isContactStopped(active))
					.map(([id]) => id),
			)
		},
		async repostedOwnerEventIds(owners) {
			if (owners.length === 0) return new Set()
			const rows = (await db
				.select({ providerEventId: contactEvent.providerEventId })
				.from(contactEvent)
				.where(
					and(
						inArray(contactEvent.contactId, [
							...new Set(owners.map((owner) => owner.contactId)),
						]),
						eq(contactEvent.eventType, OWNER_BIRTH_REPOSTED_EVENT_TYPE),
					),
				)) as { providerEventId: string }[]
			const markers = new Set(rows.map((row) => row.providerEventId))
			return new Set(
				owners
					.filter((owner) =>
						markers.has(ownerBirthRepostProviderEventId(owner.id)),
					)
					.map((owner) => owner.id),
			)
		},
	}
}
