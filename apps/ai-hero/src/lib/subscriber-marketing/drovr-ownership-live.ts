import { and, eq, inArray } from 'drizzle-orm'

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
import {
	findJourneyOwnerAssignment,
	findRecordedJourneyOwner,
	isOwnerFanOutCandidate,
} from './drovr-ownership'
import type { DrovrJourneyId } from './drovr-shadow-emitter'
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
				const [state, unsubscribeEvents, identities, links] = await Promise.all(
					[
						repository.findCurrentContactState(contactId),
						repository.findContactEventsByType(
							contactId,
							'contact.unsubscribed',
						),
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
					],
				)
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
						unsubscribeEvents.length > 0 ||
						isSuppressedLifecycle(contact.lifecycle) ||
						isSuppressedLifecycle(state?.lifecycle),
				}
			},
		},
		contactId: args.contactId,
		completedAt: args.completedAt,
	})
}

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
			await log.warn('drovr.owner.resolve_failed', {
				contacts: candidates.size,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot make the read succeed.
		}
		return []
	}
}
