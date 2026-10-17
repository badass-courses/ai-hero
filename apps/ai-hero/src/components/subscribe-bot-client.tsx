'use client'

import { SUBSCRIBE_BOT_CONFIG } from '@/lib/subscribe-bot-config'
import { initBotId } from 'botid/client/core'

// This client entry is only referenced by enabled server renders.
if (typeof window !== 'undefined') {
	initBotId({ protect: SUBSCRIBE_BOT_CONFIG.protect })
}

export function SubscribeBotClient() {
	return null
}
