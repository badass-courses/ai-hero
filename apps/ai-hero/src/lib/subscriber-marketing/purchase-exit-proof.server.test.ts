import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FLAGS, PURCHASE_EXIT_PROOF } from '@/flags/flag-definitions'
import { decodeFlagValue, redisAdapter } from '@/flags/flags-adapter'
import { getFlagKey } from '@/flags/flag-key'
import { getEnvKey } from '@/flags/flags-env'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({ env: { COURSEBUILDER_URL: 'https://example.test' } }))
vi.mock('@/server/redis-client', () => ({ redis: { get: mocks.get } }))

import { purchaseExitProofEnabled } from './purchase-exit-proof.server'

describe('purchase exit proof flag', () => {
	beforeEach(() => mocks.get.mockReset().mockResolvedValue(null))

	it('is off by default everywhere and for a missing value', async () => {
		expect(Object.values(FLAGS[PURCHASE_EXIT_PROOF].defaultValue)).toEqual([
			false,
			false,
			false,
			false,
		])
		expect(decodeFlagValue(null)).toBe(false)
		expect(await purchaseExitProofEnabled()).toBe(false)
	})

	it('reads the key the admin toggle writes, and the Vercel adapter reads the same one', async () => {
		const store = new Map<string, unknown>()
		mocks.get.mockImplementation(async (key: string) => store.get(key) ?? null)
		// toggleFlag writes getFlagKey(key); the flag instance key is getEnvKey(key).
		store.set(getFlagKey(PURCHASE_EXIT_PROOF), 'true')
		expect(await purchaseExitProofEnabled()).toBe(true)
		const decided = await redisAdapter().decide({
			key: getEnvKey(PURCHASE_EXIT_PROOF),
		} as never)
		expect(decided).toBe(true)
		store.set(getFlagKey(PURCHASE_EXIT_PROOF), 'false')
		expect(await purchaseExitProofEnabled()).toBe(false)
	})

	it('fails closed on a store error or a slow read', async () => {
		mocks.get.mockRejectedValueOnce(new Error('down'))
		expect(await purchaseExitProofEnabled()).toBe(false)
		mocks.get.mockReturnValueOnce(new Promise(() => undefined))
		expect(await purchaseExitProofEnabled(20)).toBe(false)
	})
})
