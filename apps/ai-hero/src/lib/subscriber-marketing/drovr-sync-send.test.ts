import { describe, expect, it } from 'vitest'

import {
	DEFAULT_DROVR_SEND_BUDGET_PER_MINUTE,
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
})
