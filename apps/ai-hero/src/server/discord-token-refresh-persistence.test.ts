import { describe, expect, it, vi } from 'vitest'

import type { DiscordRefreshResult } from './discord-token-refresh'
import {
	claimDiscordRefresh,
	persistDiscordRefreshResult,
	type DiscordAccountCredentials,
} from './discord-token-refresh-persistence'

const expected = {
	accessToken: 'old-access-token',
	refreshToken: 'old-refresh-token',
	expiresAt: 1_700_000_000,
}
const claimExpiresAt = 1_700_000_007
const refreshed: DiscordRefreshResult = {
	status: 'refreshed',
	accessToken: 'new-access-token',
	refreshToken: 'new-refresh-token',
	expiresIn: 3600,
	attempts: 1,
}
const reconnectRequired: DiscordRefreshResult = {
	status: 'reconnect-required',
	reasonCode: 'invalid-grant',
	attempts: 1,
}

function createStore() {
	let row: DiscordAccountCredentials | null = { ...expected }

	return {
		get row() {
			return row
		},
		read: vi.fn(async () => (row ? { ...row } : null)),
		claim: vi.fn(async () => {
			if (
				row?.refreshToken !== expected.refreshToken ||
				row.expiresAt !== expected.expiresAt
			) {
				return 0
			}
			row = { ...row, expiresAt: claimExpiresAt }
			return 1
		}),
		writeClaimed: vi.fn(
			async (update: Partial<DiscordAccountCredentials>) => {
				if (
					row?.refreshToken !== expected.refreshToken ||
					row.expiresAt !== claimExpiresAt
				) {
					return 0
				}
				row = { ...row, ...update }
				return 1
			},
		),
		recoverCleared: vi.fn(
			async (update: Partial<DiscordAccountCredentials>) => {
				if (
					row?.accessToken !== null ||
					row?.refreshToken !== null ||
					row?.expiresAt !== null
				) {
					return 0
				}
				row = { ...row, ...update } as DiscordAccountCredentials
				return 1
			},
		),
	}
}

describe('Discord token refresh persistence', () => {
	it('atomically gives one concurrent refresher the claim', async () => {
		const store = createStore()

		const results = await Promise.all([
			claimDiscordRefresh({
				expected,
				claimExpiresAt,
				claim: store.claim,
				read: store.read,
			}),
			claimDiscordRefresh({
				expected,
				claimExpiresAt,
				claim: store.claim,
				read: store.read,
			}),
		])

		expect(results).toContainEqual({
			status: 'claimed',
			databaseOutcome: 'claim-applied',
		})
		expect(results).toContainEqual({
			status: 'stale-result',
			databaseOutcome: 'claim-stale',
		})
		expect(store.claim).toHaveBeenCalledTimes(2)
	})

	it('preserves the rotated credential when success writes before invalid_grant', async () => {
		const store = createStore()
		await store.claim()

		const success = await persistDiscordRefreshResult({
			result: refreshed,
			expected,
			nowSeconds: 1_700_000_010,
			writeClaimed: store.writeClaimed,
			recoverCleared: store.recoverCleared,
			read: store.read,
		})
		const staleInvalidGrant = await persistDiscordRefreshResult({
			result: reconnectRequired,
			expected,
			nowSeconds: 1_700_000_010,
			writeClaimed: store.writeClaimed,
			recoverCleared: store.recoverCleared,
			read: store.read,
		})

		expect(success).toEqual({
			action: 'refreshed',
			providerOutcome: 'refreshed',
			databaseOutcome: 'write-applied',
		})
		expect(staleInvalidGrant).toEqual({
			action: 'stale-result',
			providerOutcome: 'reconnect-required',
			databaseOutcome: 'write-stale',
		})
		expect(store.row).toEqual({
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
			expiresAt: 1_700_003_610,
		})
	})

	it('recovers the rotated credential when invalid_grant writes before success', async () => {
		const store = createStore()
		await store.claim()

		const invalidGrant = await persistDiscordRefreshResult({
			result: reconnectRequired,
			expected,
			nowSeconds: 1_700_000_010,
			writeClaimed: store.writeClaimed,
			recoverCleared: store.recoverCleared,
			read: store.read,
		})
		const recoveredSuccess = await persistDiscordRefreshResult({
			result: refreshed,
			expected,
			nowSeconds: 1_700_000_010,
			writeClaimed: store.writeClaimed,
			recoverCleared: store.recoverCleared,
			read: store.read,
		})

		expect(invalidGrant).toEqual({
			action: 'reconnect-required',
			providerOutcome: 'reconnect-required',
			databaseOutcome: 'write-applied',
		})
		expect(recoveredSuccess).toEqual({
			action: 'refreshed',
			providerOutcome: 'refreshed',
			databaseOutcome: 'success-recovered',
		})
		expect(store.row).toEqual({
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
			expiresAt: 1_700_003_610,
		})
	})

	it('releases the claim after a provider failure', async () => {
		const store = createStore()
		await store.claim()

		await expect(
			persistDiscordRefreshResult({
				result: {
					status: 'failed',
					reasonCode: 'retry-exhausted',
					attempts: 3,
					lastStatus: 503,
				},
				expected,
				nowSeconds: 1_700_000_010,
				writeClaimed: store.writeClaimed,
				recoverCleared: store.recoverCleared,
				read: store.read,
			}),
		).resolves.toEqual({
			action: 'failed',
			providerOutcome: 'failed',
			databaseOutcome: 'write-applied',
		})
		expect(store.row).toEqual(expected)
	})

	it('reports a readback mismatch as stale-result', async () => {
		const store = createStore()
		await store.claim()
		store.read.mockResolvedValueOnce({
			accessToken: 'other-access-token',
			refreshToken: 'other-refresh-token',
			expiresAt: 1_700_009_999,
		})

		await expect(
			persistDiscordRefreshResult({
				result: refreshed,
				expected,
				nowSeconds: 1_700_000_010,
				writeClaimed: store.writeClaimed,
				recoverCleared: store.recoverCleared,
				read: store.read,
			}),
		).resolves.toEqual({
			action: 'stale-result',
			providerOutcome: 'refreshed',
			databaseOutcome: 'readback-mismatch',
		})
	})
})
