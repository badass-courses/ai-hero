import 'server-only'

import {
	SUBSCRIBE_BOT_ENFORCE,
	SUBSCRIBE_BOT_SHADOW,
} from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flag-key'
import { decodeFlagValue } from '@/flags/flags-adapter'
import { redis } from '@/server/redis-client'

import { SUBSCRIBE_BOT_CONFIG } from './subscribe-bot-config'
import {
	subscribeBotMode,
	type SubscribeBotMode,
} from './subscribe-bot-decision'

export async function withSubscribeBotTimeout<T>(
	work: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			Promise.resolve().then(work),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Subscribe bot check timed out')),
					timeoutMs,
				)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

// Read the admin switches fresh; missing values and flag outages leave this off.
export async function readSubscribeBotMode(): Promise<SubscribeBotMode> {
	try {
		return await withSubscribeBotTimeout(async () => {
			const [shadow, enforce] = await Promise.all([
				redis.get(getFlagKey(SUBSCRIBE_BOT_SHADOW)),
				redis.get(getFlagKey(SUBSCRIBE_BOT_ENFORCE)),
			])
			return subscribeBotMode({
				shadow: decodeFlagValue(shadow),
				enforce: decodeFlagValue(enforce),
			})
		}, SUBSCRIBE_BOT_CONFIG.flagTimeoutMs)
	} catch {
		return 'off'
	}
}
