import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const querySource = readFileSync(
	new URL('./discord-query.ts', import.meta.url),
	'utf8',
)
const actionSource = readFileSync(
	new URL('./discord-disconnect-action.ts', import.meta.url),
	'utf8',
)
const profileSource = readFileSync(
	new URL(
		'../app/(user)/profile/_components/edit-profile-form.tsx',
		import.meta.url,
	),
	'utf8',
)

describe('Discord server boundary', () => {
	it('keeps account reads and bot-token fetches out of the server-action graph', () => {
		expect(querySource).toContain("import 'server-only'")
		expect(querySource).not.toContain("'use server'")
		expect(querySource).toContain('export async function getDiscordAccount')
		expect(querySource).toContain('export async function fetchAsDiscordBot')
		expect(querySource).toContain('export async function fetchJsonAsDiscordBot')
		expect(querySource).not.toContain('disconnectDiscord')
	})

	it('exports only the session-derived disconnect action to clients', () => {
		const exports = [...actionSource.matchAll(/export async function (\w+)/g)].map(
			(match) => match[1],
		)

		expect(actionSource).toContain("'use server'")
		expect(actionSource).toContain('getServerAuthSession()')
		expect(actionSource).not.toContain('DISCORD_BOT_TOKEN')
		expect(exports).toEqual(['disconnectDiscord'])
	})

	it('imports the narrow action from the client profile form', () => {
		expect(profileSource).toContain(
			"import { disconnectDiscord } from '@/lib/discord-disconnect-action'",
		)
		expect(profileSource).not.toContain(
			"import { disconnectDiscord } from '@/lib/discord-query'",
		)
	})
})
