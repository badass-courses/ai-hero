'use client'

import {
	SUBSCRIBE_BOT_PROTECT,
	SUBSCRIBE_BOT_ROUTES,
} from '@/lib/subscribe-bot-routes'

// Each form checks the cached public mode. Only an enabled mode can start the
// one-time SDK import; a failed import can be retried on a later mount/submit.
let initializer: Promise<void> | undefined

export async function initializeSubscribeBotProtection(): Promise<void> {
	try {
		const response = await fetch(SUBSCRIBE_BOT_ROUTES.mode, {
			signal: AbortSignal.timeout(SUBSCRIBE_BOT_ROUTES.modeTimeoutMs),
		})
		if (!response.ok) return
		const { mode } = await response.json()
		if (mode !== 'shadow' && mode !== 'enforce') return
		initializer ??= import('botid/client/core')
			.then(({ initBotId }) => {
				initBotId({ protect: SUBSCRIBE_BOT_PROTECT })
			})
			.catch((error: unknown) => {
				initializer = undefined
				throw error
			})
		await initializer
	} catch {
		// Client discovery or SDK loading must not disable the form.
	}
}
