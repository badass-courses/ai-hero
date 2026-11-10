import { and, eq, inArray } from 'drizzle-orm'

import { readActiveContactStops } from './contact-stop-rule'
import { log } from '@/server/logger'

import { normalizeEmail } from './contact-email-equivalence'
import {
	CRASH_COURSE_PRODUCT_ID,
	CRASH_COURSE_PURCHASE_STATUSES,
	enterEvergreenPitch,
	hasCrashCoursePurchaseForIdentity,
	type EvergreenPitchEntryResult,
	isSuppressedLifecycle,
} from './drovr-pitch-entry'
import { DOI_REQUESTED_EVENT_TYPE } from './drovr-doi-signup'
import {
	answeredEmailResourceIdOf,
	fanOutOwnedEvents,
	findJourneyOwnerAssignment,
	findRecordedJourneyOwner,
	isDoiAnswerForwardCandidate,
	isDoiAnswerForwardContact,
	isOwnerFanOutCandidate,
	isShadowNewsletterBirth,
} from './drovr-ownership'
import {
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	type DrovrJourneyId,
} from './drovr-shadow-emitter'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * Which contacts in a batch drovr owns, read from the live database. Both
 * delivery paths use it: the durable Inngest function and the direct
 * fallback. Imports are lazy because the host libraries that dispatch
 * facts must not load the database just to record one; a failed read
 * means no fan-out for this batch, logged, never a thrown error into the
 * host flow.
 */
export async function enterEvergreenPitchFromLiveDatabase(args: {
	contactId: string
	completedAt: string
}): Promise<EvergreenPitchEntryResult> {
	const [{ db }, schema, { DrizzleCaptureMarketingRepository }] =
		await Promise.all([
			import('@/db'),
			import('@/db/schema'),
			import('./drizzle-capture-repository'),
		])
	const repository = new DrizzleCaptureMarketingRepository(db)
	return enterEvergreenPitch({
		repository: {
			findContactEventsByType:
				repository.findContactEventsByType.bind(repository),
			createContactEvent: repository.createContactEvent.bind(repository),
			async readEvergreenPitchEntryEvidence(contactId) {
				const contact = await repository.findContactById(contactId)
				if (!contact?.email) return undefined
				const normalizedEmail = normalizeEmail(contact.email)
				const [state, stops, identities, links] = await Promise.all([
					repository.findCurrentContactState(contactId),
					// A fresh double opt-in lifts an unsubscribe (contact-stop-rule).
					readActiveContactStops(repository, contactId),
					db
						.select()
						.from(schema.providerIdentity)
						.where(
							and(
								eq(schema.providerIdentity.contactId, contactId),
								inArray(schema.providerIdentity.provider, ['kit', 'ai-hero']),
							),
						)
						.limit(2),
					db
						.select({ userId: schema.contactLink.userId })
						.from(schema.contactLink)
						.where(eq(schema.contactLink.contactId, contactId)),
				])
				const identityRow =
					identities.find((identity) => identity.provider === 'kit') ??
					identities[0]
				if (!identityRow) return undefined
				const identity = await repository.findProviderIdentity(
					identityRow.provider,
					identityRow.externalId,
				)
				if (!identity) return undefined

				const linkedUserIds = Array.from(
					new Set(
						[contact.userId, ...links.map((link) => link.userId)].filter(
							(userId): userId is string => Boolean(userId),
						),
					),
				)
				const [linkedUsers, emailUsers] = await Promise.all([
					linkedUserIds.length
						? db
								.select({ id: schema.users.id, email: schema.users.email })
								.from(schema.users)
								.where(inArray(schema.users.id, linkedUserIds))
						: Promise.resolve([]),
					db
						.select({ id: schema.users.id, email: schema.users.email })
						.from(schema.users)
						.where(eq(schema.users.email, normalizedEmail)),
				])
				const purchaserUserIds = Array.from(
					new Set([
						...linkedUserIds,
						...linkedUsers.map((user) => user.id),
						...emailUsers.map((user) => user.id),
					]),
				)
				const matchingPurchases = purchaserUserIds.length
					? await db
							.select({
								userId: schema.purchases.userId,
								productId: schema.purchases.productId,
								status: schema.purchases.status,
							})
							.from(schema.purchases)
							.where(
								and(
									inArray(schema.purchases.userId, purchaserUserIds),
									eq(schema.purchases.productId, CRASH_COURSE_PRODUCT_ID),
									inArray(schema.purchases.status, [
										...CRASH_COURSE_PURCHASE_STATUSES,
									]),
								),
							)
							.limit(1)
					: []
				const emailsByUserId = new Map(
					[...linkedUsers, ...emailUsers].map((user) => [user.id, user.email]),
				)
				return {
					contact: { ...contact, email: contact.email },
					providerIdentity: identity,
					hasCrashCoursePurchase: hasCrashCoursePurchaseForIdentity({
						userIds: purchaserUserIds,
						emails: [contact.email],
						purchases: matchingPurchases.map((purchase) => ({
							...purchase,
							userEmail:
								purchase.userId === null
									? undefined
									: emailsByUserId.get(purchase.userId),
						})),
					}),
					unsubscribed:
						stops.unsubscribed ||
						isSuppressedLifecycle(contact.lifecycle) ||
						isSuppressedLifecycle(state?.lifecycle),
				}
			},
		},
		contactId: args.contactId,
		completedAt: args.completedAt,
	})
}

/**
 * Which contacts in a batch drovr owns, so their facts (a Kit stop among
 * them) also reach the authority tenant. A failed read throws: the durable
 * deliver function runs this in a step, and a thrown step is retried while
 * a returned [] would be memoized and the authority copy lost for good.
 * Only a real read that finds no owners answers [].
 */
export async function resolveOwnedContactIds(
	events: readonly DrovrShadowEvent[],
	options: { journeyId?: DrovrJourneyId } = {},
): Promise<string[]> {
	const candidates = new Set(
		events.filter(isOwnerFanOutCandidate).map((event) => event.contactId),
	)
	if (candidates.size === 0) return []
	try {
		const [{ db }, { DrizzleCaptureMarketingRepository }] = await Promise.all([
			import('@/db'),
			import('./drizzle-capture-repository'),
		])
		const repository = new DrizzleCaptureMarketingRepository(db)
		const owned: string[] = []
		for (const contactId of candidates) {
			const assigned = options.journeyId
				? await findJourneyOwnerAssignment(
						repository,
						contactId,
						options.journeyId,
					)
				: await findRecordedJourneyOwner(repository, contactId)
			if (options.journeyId ? assigned !== undefined : assigned === 'drovr') {
				owned.push(contactId)
			}
		}
		return owned
	} catch (error) {
		try {
			await log.error('drovr.owner.resolve_failed', {
				contacts: candidates.size,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot make the read succeed.
		}
		throw error
	}
}

export type DoiAnswerForwardReads = {
	doiRequestedAt(contactId: string): Promise<string[]>
	anchoredEmailResourceIds(
		contactId: string,
		emailResourceIds: readonly string[],
	): Promise<Set<string>>
}

/**
 * Which DOI learners in a batch get their skills-course answers copied to
 * the authority tenant (`isDoiAnswerForwardContact`). Unlike the owner read
 * this never throws: a failed read leaves these answers where they went
 * before (discarded, the drip timer still moves the learner on) and is
 * logged at error. Throwing would hold or outbox the whole batch, owned
 * contacts' stops included, over an answer that never reached drovr before.
 */
export async function resolveDoiAnswerForwardContactIds(
	events: readonly DrovrShadowEvent[],
	options: { since?: string; reads?: DoiAnswerForwardReads } = {},
): Promise<string[]> {
	const answered = new Map<string, Set<string>>()
	for (const event of events) {
		if (!isDoiAnswerForwardCandidate(event)) continue
		const emailResourceId = answeredEmailResourceIdOf(event)
		if (!emailResourceId) continue
		const ids = answered.get(event.contactId) ?? new Set<string>()
		ids.add(emailResourceId)
		answered.set(event.contactId, ids)
	}
	if (answered.size === 0) return []
	try {
		const reads = options.reads ?? (await liveDoiAnswerForwardReads())
		const forwarded: string[] = []
		for (const [contactId, ids] of answered) {
			const doiRequestedAt = await reads.doiRequestedAt(contactId)
			if (doiRequestedAt.length === 0) continue
			const answeredEmailResourceIds = [...ids]
			const anchoredEmailResourceIds = await reads.anchoredEmailResourceIds(
				contactId,
				answeredEmailResourceIds,
			)
			if (
				isDoiAnswerForwardContact({
					doiRequestedAt,
					answeredEmailResourceIds,
					anchoredEmailResourceIds,
					since: options.since,
				})
			)
				forwarded.push(contactId)
		}
		return forwarded
	} catch (error) {
		try {
			await log.error('drovr.doi_answer_forward.resolve_failed', {
				contacts: answered.size,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot make the read succeed.
		}
		return []
	}
}

/**
 * Owner fan-out with every owner set read live, for a path with no step
 * memo (the outbox replay). An owner read failure throws, as
 * `resolveOwnedContactIds` does; the DOI answer read never does.
 */
export async function fanOutOwnedEventsLive(
	events: readonly DrovrShadowEvent[],
	deps: {
		resolveOwners?: typeof resolveOwnedContactIds
		resolveDoiAnswerForwards?: (
			events: readonly DrovrShadowEvent[],
		) => Promise<string[]>
	} = {},
): Promise<DrovrShadowEvent[]> {
	const resolveOwners = deps.resolveOwners ?? resolveOwnedContactIds
	const resolveDoiAnswerForwards =
		deps.resolveDoiAnswerForwards ?? resolveDoiAnswerForwardContactIds
	const owned = await resolveOwners(events)
	const births = events.filter(isShadowNewsletterBirth)
	const newsletterOwned = births.length
		? await resolveOwners(births, {
				journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
			})
		: []
	const doiAnswerForwards = await resolveDoiAnswerForwards(events).catch(
		() => [] as string[],
	)
	return fanOutOwnedEvents(
		events,
		new Set(owned),
		new Set(newsletterOwned),
		new Set(doiAnswerForwards),
	)
}

async function liveDoiAnswerForwardReads(): Promise<DoiAnswerForwardReads> {
	const { db } = await import('@/db')
	return createDoiAnswerForwardReads(db)
}

/**
 * The reads over a given database: the app's in production, any drizzle
 * MySQL handle in a dry run against a read replica.
 */
export async function createDoiAnswerForwardReads(
	db: ConstructorParameters<
		typeof import('./drizzle-capture-repository').DrizzleCaptureMarketingRepository
	>[0],
): Promise<DoiAnswerForwardReads> {
	const [{ valuePathLinkAnchor }, { DrizzleCaptureMarketingRepository }] =
		await Promise.all([
			import('@/db/contact-sync-schema'),
			import('./drizzle-capture-repository'),
		])
	const repository = new DrizzleCaptureMarketingRepository(db)
	return {
		async doiRequestedAt(contactId) {
			const events = await repository.findContactEventsByType(
				contactId,
				DOI_REQUESTED_EVENT_TYPE,
			)
			return events.map((event: { occurredAt: string }) => event.occurredAt)
		},
		async anchoredEmailResourceIds(contactId, emailResourceIds) {
			// ValuePathLinkAnchor_contact_idx serves the contact filter.
			const rows = await db
				.select({ emailResourceId: valuePathLinkAnchor.emailResourceId })
				.from(valuePathLinkAnchor)
				.where(
					and(
						eq(valuePathLinkAnchor.contactId, contactId),
						inArray(valuePathLinkAnchor.emailResourceId, [...emailResourceIds]),
					),
				)
			return new Set(
				rows.map((row: { emailResourceId: string }) => row.emailResourceId),
			)
		},
	}
}
