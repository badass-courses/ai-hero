import { NonRetriableError } from 'inngest'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import {
	buildContactProfileEvents,
	type ContactOfferIssue,
} from './drovr-contact-profile-sync'

export function profileVersionForRefresh(event: DrovrShadowEvent): number {
	const value =
		event.payload && 'profileVersion' in event.payload
			? event.payload.profileVersion
			: undefined
	if (
		event.type !== 'contact.profile.updated' ||
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 1
	)
		throw new NonRetriableError(
			'OfferRefreshVersion: you accepted a profile update, and it failed because its version is invalid. Accepted: a positive integer profileVersion. Fix: inspect the accepted payload before refreshing. Debug: compare the profile receipt with its schema.',
		)
	return value
}

/** A queued bump never owns coupon bytes. Read the current coupon only after
 * its profile landed; a superseded version leaves refresh to the newer bump.
 */
export async function currentOfferAfterProfile(
	request: { contactId: string; profileVersion: number },
	ports: {
		currentVersion(
			contactId: string,
		): Promise<{ profileVersion: number } | undefined>
		readOffer(contactId: string): Promise<ContactOfferIssue | undefined>
	},
) {
	if (
		(await ports.currentVersion(request.contactId))?.profileVersion !==
		request.profileVersion
	)
		return []
	const offer = await ports.readOffer(request.contactId)
	if (!offer?.issuedAt) return []
	return buildContactProfileEvents({
		...request,
		occurredAt: offer.issuedAt,
		profile: { email: '', firstName: null, holds: [] },
		links: [],
		offers: [offer],
	}).filter((event) => event.type === 'contact.offer.issued')
}
export async function readCurrentOfferAfterProfile(request: {
	contactId: string
	profileVersion: number
}) {
	const [
		{ db },
		{ env },
		{ DrizzleCaptureMarketingRepository },
		{ createDrizzleContactProfileVersionStore },
		{ findEvergreenOffer },
		{ DROVR_EVERGREEN_OFFER_JOURNEY_ID },
	] = await Promise.all([
		import('@/db'),
		import('@/env.mjs'),
		import('./drizzle-capture-repository'),
		import('./contact-profile-version-drizzle'),
		import('./drovr-personalize'),
		import('./drovr-shadow-emitter'),
	])
	const repository = new DrizzleCaptureMarketingRepository(db)
	return currentOfferAfterProfile(request, {
		currentVersion: createDrizzleContactProfileVersionStore(db).currentFor,
		readOffer: async (contactId) => {
			const offer = await findEvergreenOffer({
				repository,
				contactId,
				origin:
					env.NEXT_PUBLIC_URL ??
					env.NEXT_PUBLIC_SITE_URL ??
					'https://www.aihero.dev',
			})
			return offer
				? { journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID, ...offer }
				: undefined
		},
	})
}
