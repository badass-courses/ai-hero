import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: vi.fn((config) => ({ config })) },
}))
vi.mock('@/lib/discord-query', () => ({ getDiscordAccount: vi.fn() }))
vi.mock('@/lib/discord-utils', () => ({ removeDiscordRole: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: {} }))

import {
	removePurchaseRoleDiscord,
	removePurchaseRoleDiscordConfig,
} from './remove-purchase-role-discord'

describe('remove-purchase-role-discord concurrency', () => {
	it('serializes runs so concurrent refunds see each other soft-deletes', () => {
		expect(removePurchaseRoleDiscordConfig.concurrency.limit).toBe(1)
		expect(
			(removePurchaseRoleDiscord as unknown as { config: unknown }).config,
		).toMatchObject({ concurrency: { limit: 1 } })
	})
})
