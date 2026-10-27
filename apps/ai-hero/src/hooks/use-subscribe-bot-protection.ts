'use client'

import { useCallback, useEffect, useRef } from 'react'
import { initializeSubscribeBotProtection } from '@/components/subscribe-bot-client'
import { SUBSCRIBE_BOT_ROUTES } from '@/lib/subscribe-bot-routes'

export function useSubscribeBotProtection(
	submitUrl = SUBSCRIBE_BOT_ROUTES.subscribe,
) {
	const discovery = useRef<{
		url: string
		startedAt: number
		promise: Promise<void>
	} | null>(null)
	const prepare = useCallback(async () => {
		if (submitUrl !== SUBSCRIBE_BOT_ROUTES.subscribe) return
		const now = Date.now()
		if (
			!discovery.current ||
			discovery.current.url !== submitUrl ||
			now - discovery.current.startedAt >= SUBSCRIBE_BOT_ROUTES.discoveryReuseMs
		) {
			discovery.current = {
				url: submitUrl,
				startedAt: now,
				promise: initializeSubscribeBotProtection(),
			}
		}
		await discovery.current.promise
	}, [submitUrl])

	useEffect(() => {
		void prepare()
	}, [prepare])
	return prepare
}
