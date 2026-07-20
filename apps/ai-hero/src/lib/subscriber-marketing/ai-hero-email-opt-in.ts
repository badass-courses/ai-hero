export const AI_HERO_UNSUBSCRIBED_TAG_ID = '8244351' as const

export type AiHeroEmailOptInResult =
	| { status: 'confirmation-required' }
	| { status: 'active'; removedUnsubscribeTag: boolean }

type KitTag = {
	id: string | number
	name?: string
}

type KitSubscriber = {
	state?: string
	tags?: KitTag[]
}

export async function reconcileAiHeroEmailOptIn(args: {
	email: string
	subscriberState?: string
	getSubscriberByEmail: (email: string) => Promise<KitSubscriber | null | undefined>
	removeUnsubscribeTag: (email: string) => Promise<void>
}): Promise<AiHeroEmailOptInResult> {
	if (args.subscriberState !== 'active') {
		return { status: 'confirmation-required' }
	}

	const before = await args.getSubscriberByEmail(args.email)
	const hasUnsubscribeTag = before?.tags?.some(
		(tag) => String(tag.id) === AI_HERO_UNSUBSCRIBED_TAG_ID,
	)
	if (!hasUnsubscribeTag) {
		return { status: 'active', removedUnsubscribeTag: false }
	}

	await args.removeUnsubscribeTag(args.email)
	const after = await args.getSubscriberByEmail(args.email)
	if (
		after?.tags?.some(
			(tag) => String(tag.id) === AI_HERO_UNSUBSCRIBED_TAG_ID,
		)
	) {
		throw new Error('Kit unsubscribe tag removal did not persist')
	}

	return { status: 'active', removedUnsubscribeTag: true }
}
