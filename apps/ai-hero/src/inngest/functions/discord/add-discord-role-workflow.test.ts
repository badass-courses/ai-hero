import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: () => ({}) },
}))
vi.mock('@/lib/discord-utils', () => ({ discordRoleClient: {} }))

import { addDiscordRoles } from './add-discord-role-workflow'

function guild(initial: string[]) {
	const roles = new Set(initial)
	return {
		roles,
		client: {
			lookupMember: vi.fn(async () => ({
				kind: 'member' as const,
				discordAccountId: 'd1',
				roles: [...roles],
			})),
			// Discord's PUT adds one role without touching the others.
			addRole: vi.fn(async (_id: string, roleId: string) => {
				roles.add(roleId)
			}),
		},
	}
}

describe('addDiscordRoles', () => {
	it('keeps both roles when the cohort and workshop events run at once', async () => {
		const g = guild(['everyone'])
		await Promise.all([
			addDiscordRoles(g.client, 'u1', ['cohort-005']),
			addDiscordRoles(g.client, 'u1', ['crash-course']),
		])
		expect([...g.roles].sort()).toEqual([
			'cohort-005',
			'crash-course',
			'everyone',
		])
	})

	it('adds only roles the member lacks', async () => {
		const g = guild(['cohort-005'])
		expect(
			await addDiscordRoles(g.client, 'u1', ['cohort-005', 'crash-course']),
		).toEqual({ added: ['crash-course'], alreadyHad: 1 })
		expect(g.client.addRole).toHaveBeenCalledTimes(1)
	})

	it.each(['not-member', 'no-account'] as const)(
		'skips a %s without writing',
		async (kind) => {
			const addRole = vi.fn()
			const result = await addDiscordRoles(
				{
					lookupMember: vi.fn(async () =>
						kind === 'not-member' ? { kind, discordAccountId: 'd1' } : { kind },
					),
					addRole,
				},
				'u1',
				['cohort-005'],
			)
			expect(result).toEqual({ skipped: kind })
			expect(addRole).not.toHaveBeenCalled()
		},
	)

	it('lets a failed add throw so the step retries', async () => {
		const g = guild([])
		g.client.addRole.mockRejectedValueOnce(
			new Error('discord add role failed: 429'),
		)
		await expect(
			addDiscordRoles(g.client, 'u1', ['cohort-005']),
		).rejects.toThrow('429')
	})
})
