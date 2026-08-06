import 'server-only'

import { db } from '@/db'
import { accounts } from '@/db/schema'
import { env } from '@/env.mjs'
import { and, eq } from 'drizzle-orm'

export async function getDiscordAccount(userId: string) {
	return db.query.accounts.findFirst({
		where: and(eq(accounts.userId, userId), eq(accounts.provider, 'discord')),
	})
}

export async function fetchJsonAsDiscordBot<JsonType = unknown>(
	endpoint: string,
	config?: RequestInit,
) {
	const res = await fetchAsDiscordBot(endpoint, {
		...config,
		headers: {
			'Content-Type': 'application/json',
			...config?.headers,
		},
	})
	return (await res.json().catch((e) => e)) as JsonType
}

export async function fetchAsDiscordBot(
	endpoint: string,
	config?: RequestInit,
) {
	const url = new URL(`https://discord.com/api/${endpoint}`)
	return await fetch(url.toString(), {
		...config,
		headers: {
			Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
			...config?.headers,
		},
	})
}
