'use client'

import { useCallback, useEffect } from 'react'
import { initializeSubscribeBotProtection } from '@/components/subscribe-bot-client'
import { SUBSCRIBE_BOT_ROUTES } from '@/lib/subscribe-bot-routes'

export function useSubscribeBotProtection(
	submitUrl = SUBSCRIBE_BOT_ROUTES.subscribe,
) {
	const prepare = useCallback(async () => {
		if (submitUrl === SUBSCRIBE_BOT_ROUTES.subscribe) {
			await initializeSubscribeBotProtection()
		}
	}, [submitUrl])

	useEffect(() => {
		void prepare()
	}, [prepare])
	return prepare
}
