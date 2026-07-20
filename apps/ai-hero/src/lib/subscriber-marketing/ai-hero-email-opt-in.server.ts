import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'

import {
	AI_HERO_UNSUBSCRIBED_TAG_ID,
	reconcileAiHeroEmailOptIn,
} from './ai-hero-email-opt-in'

export async function reconcileAiHeroEmailOptInWithKit(args: {
	email: string
	subscriberState?: string
}) {
	return reconcileAiHeroEmailOptIn({
		...args,
		getSubscriberByEmail: (email) =>
			emailListProvider.getSubscriberByEmail(email),
		removeUnsubscribeTag: removeAiHeroUnsubscribeTag,
	})
}

async function removeAiHeroUnsubscribeTag(email: string) {
	const response = await fetch(
		`https://api.convertkit.com/v3/tags/${AI_HERO_UNSUBSCRIBED_TAG_ID}/unsubscribe`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				api_secret: env.CONVERTKIT_API_SECRET,
				email,
			}),
		},
	)

	if (!response.ok && response.status !== 404) {
		throw new Error(
			`Kit unsubscribe tag removal failed with HTTP ${response.status}`,
		)
	}
}
