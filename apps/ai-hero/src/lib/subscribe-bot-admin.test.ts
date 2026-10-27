import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock('@/server/redis-client', () => ({
	redis: {
		get: async (key: string) => mocks.values.get(key) ?? null,
		set: async (key: string, value: unknown) => {
			mocks.values.set(key, value)
		},
	},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({
		session: { user: { id: 'synthetic-admin' } },
		ability: { can: () => true },
	}),
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { toggleFlag } from '@/app/admin/flags/actions'
import {
	precomputeFlags,
	subscribeBotEnforceFlag,
	subscribeBotShadowFlag,
} from '@/flags/flags'
import {
	SUBSCRIBE_BOT_ENFORCE,
	SUBSCRIBE_BOT_SHADOW,
} from '@/flags/flag-definitions'
import { readSubscribeBotMode } from './subscribe-bot-mode.server'

describe('admin-to-subscribe flag integration', () => {
	beforeEach(() => {
		mocks.values.clear()
	})

	it('reads string values written by the real authenticated admin action', async () => {
		expect(await readSubscribeBotMode()).toBe('off')
		await toggleFlag(SUBSCRIBE_BOT_SHADOW, true)
		expect(await readSubscribeBotMode()).toBe('shadow')
		await toggleFlag(SUBSCRIBE_BOT_ENFORCE, true)
		expect(await readSubscribeBotMode()).toBe('enforce')
		await toggleFlag(SUBSCRIBE_BOT_ENFORCE, false)
		expect(await readSubscribeBotMode()).toBe('shadow')
		await toggleFlag(SUBSCRIBE_BOT_SHADOW, false)
		expect(await readSubscribeBotMode()).toBe('off')
	})

	it('excludes both flags from precomputation', () => {
		expect(precomputeFlags).not.toContain(subscribeBotShadowFlag)
		expect(precomputeFlags).not.toContain(subscribeBotEnforceFlag)
		expect(precomputeFlags).toHaveLength(3)
	})
})
