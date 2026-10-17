import 'server-only'

import { createHmac } from 'node:crypto'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { pendingSubscribeResponse } from './pending-subscribe-response'

import { SUBSCRIBE_BOT_CONFIG } from './subscribe-bot-config'
import {
	decideSubscribe,
	type SubscribeBotSignal,
} from './subscribe-bot-decision'
import {
	readSubscribeBotMode,
	withSubscribeBotTimeout,
} from './subscribe-bot-mode.server'

export async function guardSubscribe(body: {
	email?: unknown
	name?: unknown
}): Promise<Response | null> {
	const mode = await readSubscribeBotMode()
	if (mode === 'off') return null

	let botid: SubscribeBotSignal
	try {
		const verification = await withSubscribeBotTimeout(async () => {
			const { checkBotId } = await import('botid/server')
			return checkBotId()
		}, SUBSCRIBE_BOT_CONFIG.botIdTimeoutMs)
		if (typeof verification.isBot !== 'boolean')
			throw new Error('Invalid BotID result')
		botid = verification.isBot ? 'bot' : 'human'
	} catch {
		botid = 'error'
	}

	const decision = decideSubscribe({ botid, firstName: body.name })
	const event =
		decision.action === 'allow'
			? 'subscribe.bot_allowed'
			: mode === 'shadow'
				? 'subscribe.bot_would_block'
				: 'subscribe.bot_rejected'
	let emailHash: string | undefined
	try {
		const scopedKey = createHmac('sha256', env.NEXTAUTH_SECRET)
			.update('subscribe-bot-v1')
			.digest()
		emailHash =
			typeof body.email === 'string'
				? createHmac('sha256', scopedKey)
						.update(body.email.trim().toLowerCase())
						.digest('hex')
						.slice(0, SUBSCRIBE_BOT_CONFIG.emailHashLength)
				: undefined
	} catch {
		// A missing join key must not hide the decision or include raw input.
	}
	try {
		await log.info(event, { mode, reason: decision.reason, emailHash })
	} catch {
		// Telemetry must never turn a signup into an outage.
	}

	if (mode !== 'enforce' || decision.action !== 'reject') return null
	// Same check-your-email shape as the existing pending confirmation path.
	// No invented Kit id, attribution writes or confirmation delivery.
	return pendingSubscribeResponse(body)
}
