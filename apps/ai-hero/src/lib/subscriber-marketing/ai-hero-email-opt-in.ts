export const AI_HERO_UNSUBSCRIBED_TAG_ID = '8244351' as const

export type AiHeroEmailOptInResult =
	| { status: 'confirmation-required' }
	| {
			status: 'active'
			removedUnsubscribeTag: boolean
			/** The tag is present but this request was not allowed to remove it. */
			untagSkipped?: boolean
	  }

type KitTag = {
	id: string | number
	name?: string
}

type KitSubscriber = {
	state?: string
	tags?: KitTag[] | { tags?: KitTag[] }
}

function getKitTags(subscriber: KitSubscriber | null | undefined): KitTag[] {
	const tags = subscriber?.tags
	if (tags == null) return []
	if (Array.isArray(tags)) return tags
	if (Array.isArray(tags.tags)) return tags.tags

	throw new TypeError(
		'Kit subscriber tags response has an unsupported shape',
	)
}

export async function reconcileAiHeroEmailOptIn(args: {
	email: string
	subscriberState?: string
	/** False when the pre-check could not read Kit: consent fails closed. */
	mayRemoveUnsubscribeTag?: boolean
	getSubscriberByEmail: (email: string) => Promise<KitSubscriber | null | undefined>
	removeUnsubscribeTag: (email: string) => Promise<void>
}): Promise<AiHeroEmailOptInResult> {
	if (args.subscriberState !== 'active') {
		return { status: 'confirmation-required' }
	}

	const before = await args.getSubscriberByEmail(args.email)
	const hasUnsubscribeTag = getKitTags(before).some(
		(tag) => String(tag.id) === AI_HERO_UNSUBSCRIBED_TAG_ID,
	)
	if (!hasUnsubscribeTag) {
		return { status: 'active', removedUnsubscribeTag: false }
	}

	if (args.mayRemoveUnsubscribeTag === false) {
		return { status: 'active', removedUnsubscribeTag: false, untagSkipped: true }
	}

	await args.removeUnsubscribeTag(args.email)
	const after = await args.getSubscriberByEmail(args.email)
	if (
		getKitTags(after).some(
			(tag) => String(tag.id) === AI_HERO_UNSUBSCRIBED_TAG_ID,
		)
	) {
		throw new Error('Kit unsubscribe tag removal did not persist')
	}

	return { status: 'active', removedUnsubscribeTag: true }
}

export type ReturningUnsubscriberResult =
	| { status: 'not-unsubscribed' }
	| { status: 'doi-requested' }
	/** Kit could not be read: sign-up continues, the tag must stay. */
	| { status: 'lookup-failed' }
	| { status: 'blocked'; reason: 'drovr-unconfigured' | 'unmapped-form' | 'doi-disabled' }

/**
 * A contact Kit shows tagged as an earlier AI Hero unsubscribe may come back
 * only through a fresh drovr double opt-in. Runs before any Kit subscribe or
 * untag. A tagged contact we cannot turn into a confirmation request is blocked,
 * so consent fails closed: the tag stays. A failed Kit read fails open for
 * the sign-up (liveness); the caller must then not remove the tag.
 */
export async function routeReturningUnsubscriber(args: {
	email: string
	/** Whether returning-unsubscriber DOI is switched on (drovr signup enabled). */
	doiEnabled: boolean
	/** Whether drovr has a base URL and tenant key. */
	drovrConfigured: boolean
	/** Whether the Kit form has a registered drovr double opt-in form. */
	formMapped: boolean
	getSubscriberByEmail: (
		email: string,
	) => Promise<KitSubscriber | null | undefined>
	requestDoi: () => Promise<void>
}): Promise<ReturningUnsubscriberResult> {
	let tagged: boolean
	try {
		tagged = getKitTags(await args.getSubscriberByEmail(args.email)).some(
			(tag) => String(tag.id) === AI_HERO_UNSUBSCRIBED_TAG_ID,
		)
	} catch {
		return { status: 'lookup-failed' }
	}
	if (!tagged) return { status: 'not-unsubscribed' }
	if (!args.doiEnabled) return { status: 'blocked', reason: 'doi-disabled' }
	if (!args.formMapped) return { status: 'blocked', reason: 'unmapped-form' }
	if (!args.drovrConfigured) {
		return { status: 'blocked', reason: 'drovr-unconfigured' }
	}
	await args.requestDoi()
	return { status: 'doi-requested' }
}
