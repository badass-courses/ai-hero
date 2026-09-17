import { describe, expect, it } from 'vitest'

import {
	DEFAULT_DROVR_SEND_BUDGET_PER_MINUTE,
	drovrSendBudget,
	KIT_RATE_LIMIT_RETRY_MS,
	parseDrovrSyncSendConfig,
	retryAfterMsFor,
} from './drovr-sync-send'

describe('drovr sync send config', () => {
	it('is off unless the flag is set', () => {
		expect(parseDrovrSyncSendConfig({})).toMatchObject({ enabled: false })
		expect(
			parseDrovrSyncSendConfig({ AIH_DROVR_SYNC_SEND: 'no' }),
		).toMatchObject({ enabled: false })
	})

	it('reads the per-minute budget with a default that leaves Kit room', () => {
		expect(parseDrovrSyncSendConfig({ AIH_DROVR_SYNC_SEND: 'true' })).toEqual({
			enabled: true,
			perMinute: DEFAULT_DROVR_SEND_BUDGET_PER_MINUTE,
		})
		expect(
			parseDrovrSyncSendConfig({
				AIH_DROVR_SYNC_SEND: '1',
				AIH_DROVR_SEND_BUDGET_PER_MINUTE: '30',
			}),
		).toEqual({ enabled: true, perMinute: 30 })
		expect(
			parseDrovrSyncSendConfig({
				AIH_DROVR_SYNC_SEND: '1',
				AIH_DROVR_SEND_BUDGET_PER_MINUTE: '-5',
			}),
		).toEqual({
			enabled: true,
			perMinute: DEFAULT_DROVR_SEND_BUDGET_PER_MINUTE,
		})
	})

	it("waits until the row's next retry, else a minute", () => {
		const now = '2026-09-17T00:00:00.000Z'
		expect(retryAfterMsFor('2026-09-17T00:15:00.000Z', now)).toBe(15 * 60_000)
		expect(retryAfterMsFor('2026-09-16T23:00:00.000Z', now)).toBe(
			KIT_RATE_LIMIT_RETRY_MS,
		)
		expect(retryAfterMsFor(undefined, now)).toBe(KIT_RATE_LIMIT_RETRY_MS)
	})

	it('counts sends per minute window on redis and gives refunds back', async () => {
		const counters = new Map<string, number>()
		const redis = {
			incr: async (key: string) => {
				const next = (counters.get(key) ?? 0) + 1
				counters.set(key, next)
				return next
			},
			decr: async (key: string) => {
				const next = (counters.get(key) ?? 0) - 1
				counters.set(key, next)
				return next
			},
			expire: async () => 1,
		}
		let clock = 1_000_000 * 60_000 + 15_000
		const budget = drovrSendBudget(redis, 2, () => clock)
		expect(await budget.take()).toEqual({ ok: true, retryAfterMs: 0 })
		expect(await budget.take()).toEqual({ ok: true, retryAfterMs: 0 })
		expect(await budget.take()).toEqual({ ok: false, retryAfterMs: 45_000 })
		await budget.refund()
		expect(await budget.take()).toEqual({ ok: true, retryAfterMs: 0 })
		clock += 60_000
		expect(await budget.take()).toEqual({ ok: true, retryAfterMs: 0 })
	})
})
