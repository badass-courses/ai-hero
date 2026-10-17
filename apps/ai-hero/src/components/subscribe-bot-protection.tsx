'use client'

import { useSubscribeBotProtection } from '@/hooks/use-subscribe-bot-protection'

// For custom subscribe forms that do not use the shared form hook.
export function SubscribeBotProtection() {
	useSubscribeBotProtection()
	return null
}
