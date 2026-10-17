import * as React from 'react'
import { connection } from 'next/server'
import { readSubscribeBotMode } from '@/lib/subscribe-bot-mode.server'

export async function SubscribeBotProtection() {
	// Resolve at request time, never bake the switch into a prerendered page.
	await connection()
	if ((await readSubscribeBotMode()) === 'off') return null
	const { SubscribeBotClient } = await import('./subscribe-bot-client')
	return <SubscribeBotClient />
}
