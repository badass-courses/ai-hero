import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	DISCORD_REFRESH_TOTAL_TIMEOUT_MS,
	type DiscordRefreshResult,
} from './discord-token-refresh'
import {
	DISCORD_REFRESH_CLAIM_LEASE_MS,
	claimDiscordRefresh,
	getDiscordRefreshClaimExpiresAt,
	isDiscordTokenExpired,
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

function createStore({
	claimExpiration = claimExpiresAt,
}: { claimExpiration?: number } = {}) {
	let row: DiscordAccountCredentials | null = { ...expected }

	return {
		get row() {
			return row
		},
		read: vi.fn(async () => (row ? { ...row } : null)),
		claim: vi.fn(
			async (
				claimExpected: DiscordAccountCredentials = expected,
				newExpiration = claimExpiration,
			) => {
				if (
					!row ||
					row.refreshToken !== claimExpected.refreshToken ||
					row.expiresAt !== claimExpected.expiresAt
				) {
					return 0
				}
				row = { ...row, expiresAt: newExpiration }
				return 1
			},
		),
		writeClaimed: vi.fn(
			async (update: Partial<DiscordAccountCredentials>) => {
				if (
					row?.refreshToken !== expected.refreshToken ||
					row.expiresAt !== claimExpiration
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
	it('treats a token as expired at its exact expiry timestamp', () => {
		const expiresAt = 1_700_000_000
		expect(isDiscordTokenExpired(expiresAt, expiresAt * 1000 - 1)).toBe(false)
		expect(isDiscordTokenExpired(expiresAt, expiresAt * 1000)).toBe(true)
		expect(isDiscordTokenExpired(null, expiresAt * 1000)).toBe(false)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

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

	it('makes one provider call across concurrent session refreshes', async () => {
		const store = createStore()
		const provider = vi.fn(async () => refreshed)
		const nowMs = 1_700_000_001_000

		const runRefresh = async () => {
			const snapshot = store.row
			if (!snapshot) return 'account-missing' as const
			if (!isDiscordTokenExpired(snapshot.expiresAt, nowMs)) {
				return 'not-expired' as const
			}

			const claim = await claimDiscordRefresh({
				expected: snapshot,
				claimExpiresAt,
				claim: () => store.claim(snapshot, claimExpiresAt),
				read: store.read,
			})
			if (claim.status !== 'claimed') return claim.status

			return persistDiscordRefreshResult({
				result: await provider(),
				expected: snapshot,
				nowSeconds: 1_700_000_010,
				writeClaimed: store.writeClaimed,
				recoverCleared: store.recoverCleared,
				read: store.read,
			})
		}

		const results = await Promise.all([runRefresh(), runRefresh()])

		expect(provider).toHaveBeenCalledOnce()
		expect(results).toSatisfy((outcomes: unknown[]) =>
			outcomes.includes('stale-result') || outcomes.includes('not-expired'),
		)
		expect(results).toContainEqual(
			expect.objectContaining({ action: 'refreshed' }),
		)
	})

	it('keeps the millisecond-999 claim through provider and persistence work', async () => {
		vi.useFakeTimers()
		const startedAtMs = 1_700_000_000_999
		vi.setSystemTime(startedAtMs)
		const claimExpiration = getDiscordRefreshClaimExpiresAt(Date.now())
		const oldClaimExpiration =
			Math.floor(startedAtMs / 1000) +
			Math.ceil(DISCORD_REFRESH_TOTAL_TIMEOUT_MS / 1000) +
			1
		const store = createStore({ claimExpiration })
		const provider = vi.fn(async () => {
			await new Promise<void>((resolve) =>
				setTimeout(resolve, DISCORD_REFRESH_TOTAL_TIMEOUT_MS - 100),
			)
			return refreshed
		})
		const persistDelayMs = 500

		const runSession = async () => {
			const snapshot = store.row
			if (!snapshot || !isDiscordTokenExpired(snapshot.expiresAt, Date.now())) {
				return 'not-expired' as const
			}
			const sessionClaimExpiration = getDiscordRefreshClaimExpiresAt(
				Date.now(),
			)
			const claim = await claimDiscordRefresh({
				expected: snapshot,
				claimExpiresAt: sessionClaimExpiration,
				claim: () => store.claim(snapshot, sessionClaimExpiration),
				read: store.read,
			})
			if (claim.status !== 'claimed') return claim.status

			const providerResult = await provider()
			await new Promise<void>((resolve) =>
				setTimeout(resolve, persistDelayMs),
			)
			return persistDiscordRefreshResult({
				result: providerResult,
				expected: snapshot,
				nowSeconds: Math.floor(Date.now() / 1000),
				writeClaimed: store.writeClaimed,
				recoverCleared: store.recoverCleared,
				read: store.read,
			})
		}

		const firstSession = runSession()
		expect(claimExpiration * 1000 - startedAtMs).toBeGreaterThanOrEqual(
			DISCORD_REFRESH_CLAIM_LEASE_MS,
		)
		expect(claimExpiration * 1000 - startedAtMs).toBeLessThan(
			DISCORD_REFRESH_CLAIM_LEASE_MS + 1000,
		)

		const oldLeaseBoundaryMs = oldClaimExpiration * 1000
		await vi.advanceTimersByTimeAsync(oldLeaseBoundaryMs - startedAtMs + 1)
		expect(store.row).toEqual({
			...expected,
			expiresAt: claimExpiration,
		})
		await expect(runSession()).resolves.toBe('not-expired')
		expect(provider).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(persistDelayMs)
		await expect(firstSession).resolves.toMatchObject({ action: 'refreshed' })
		expect(provider).toHaveBeenCalledOnce()
		expect(store.row).toMatchObject({
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
		})
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
