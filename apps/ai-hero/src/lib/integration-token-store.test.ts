import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeError } from '@/server/logger-utils'
import {
	decryptIntegrationToken,
	encryptIntegrationToken,
} from './integration-token-crypto'

const mocks = vi.hoisted(() => ({
	env: {
		INTEGRATION_TOKEN_KEY: undefined as string | undefined,
		DROPBOX_REFRESH_TOKEN: 'env-dropbox',
		YOUTUBE_ANALYTICS_REFRESH_TOKEN: 'env-youtube',
	},
	select: vi.fn(),
	limit: vi.fn(),
	insert: vi.fn(),
	values: vi.fn(),
	upsert: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	delete: vi.fn(),
	deleteWhere: vi.fn(),
	dbLoaded: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/server/logger', async () => ({
	log: { info: mocks.info, warn: mocks.warn, debug: mocks.debug },
	serializeError: (await import('@/server/logger-utils')).serializeError,
}))
vi.mock('@/db', () => {
	mocks.dbLoaded()
	return {
		db: { select: mocks.select, insert: mocks.insert, delete: mocks.delete },
	}
})
import {
	getIntegrationRefreshToken,
	integrationTokenStorageNotice,
	putIntegrationRefreshToken,
} from './integration-token-store'

const key = Buffer.alloc(32, 7)

describe('dormant dual-read integration token store', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.env.INTEGRATION_TOKEN_KEY = key.toString('base64')
		mocks.select.mockReturnValue({
			from: () => ({ where: () => ({ limit: mocks.limit }) }),
		})
		mocks.insert.mockReturnValue({ values: mocks.values })
		mocks.values.mockReturnValue({ onDuplicateKeyUpdate: mocks.upsert })
		mocks.limit.mockResolvedValue([])
		mocks.upsert.mockResolvedValue(undefined)
		mocks.info.mockResolvedValue(undefined)
		mocks.warn.mockResolvedValue(undefined)
		mocks.debug.mockResolvedValue(undefined)
		mocks.delete.mockReturnValue({ where: mocks.deleteWhere })
		mocks.deleteWhere.mockResolvedValue(undefined)
	})
	it('without a key returns exactly the old env source for both providers and never loads the DB', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		expect(await getIntegrationRefreshToken('youtube_analytics')).toBe(
			'env-youtube',
		)
		expect(await getIntegrationRefreshToken('dropbox', 'raw-process-env')).toBe(
			'raw-process-env',
		)
		expect(await getIntegrationRefreshToken('dropbox', '')).toBe('')
		expect(await putIntegrationRefreshToken('dropbox', 'fresh-token')).toEqual({
			ok: true,
		})
		expect(
			await putIntegrationRefreshToken('youtube_analytics', 'fresh-token'),
		).toEqual({ ok: true })
		expect(mocks.dbLoaded).not.toHaveBeenCalled()
		expect(mocks.select).not.toHaveBeenCalled()
		expect(mocks.insert).not.toHaveBeenCalled()
		expect(mocks.delete).not.toHaveBeenCalled()
		expect(mocks.warn).not.toHaveBeenCalled()
		expect(mocks.debug).toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({ reason: 'no-key' }),
		)
	})
	it.each(['dropbox', 'youtube_analytics'] as const)(
		'prefers a decryptable DB row over env for %s',
		async (provider) => {
			mocks.limit.mockResolvedValue([
				encryptIntegrationToken(provider, 'db-token', key),
			])
			expect(await getIntegrationRefreshToken(provider)).toBe('db-token')
			expect(mocks.insert).not.toHaveBeenCalled()
			expect(mocks.warn).not.toHaveBeenCalled()
		},
	)
	it.each(['dropbox', 'youtube_analytics'] as const)(
		'seeds an encrypted env token without overwriting concurrent rows for %s',
		async (provider) => {
			const fallback = provider === 'dropbox' ? 'env-dropbox' : 'env-youtube'
			expect(await getIntegrationRefreshToken(provider)).toBe(fallback)
			expect(mocks.insert).toHaveBeenCalledTimes(1)
			const row = mocks.values.mock.calls[0]![0]
			expect(row.provider).toBe(provider)
			expect(row.updatedAt).toBeInstanceOf(Date)
			expect(decryptIntegrationToken(provider, row, key)).toBe(fallback)
			expect(JSON.stringify(row)).not.toContain(fallback)
			expect(mocks.upsert).toHaveBeenCalledTimes(1)
			expect(mocks.upsert).toHaveBeenCalledWith({
				set: { provider: sql`provider` },
			})
			expect(mocks.info).toHaveBeenCalledTimes(1)
			expect(mocks.info).toHaveBeenCalledWith(
				'integration-token.seeded',
				{ provider },
			)
			expect(mocks.warn).toHaveBeenCalledWith(
				'integration-token.fallback',
				expect.objectContaining({ reason: 'no-row' }),
			)
		},
	)
	it.each(['', undefined])(
		'does not seed an empty fallback (%s)',
		async (fallback) => {
			expect(await getIntegrationRefreshToken('dropbox', fallback)).toBe(
				fallback,
			)
			expect(mocks.insert).not.toHaveBeenCalled()
			expect(mocks.info).not.toHaveBeenCalled()
		},
	)
	it('seeds the raw override instead of the env token', async () => {
		expect(await getIntegrationRefreshToken('dropbox', 'raw-override')).toBe(
			'raw-override',
		)
		expect(mocks.insert).toHaveBeenCalledTimes(1)
		expect(
			decryptIntegrationToken('dropbox', mocks.values.mock.calls[0]![0], key),
		).toBe('raw-override')
	})
	it('preserves fallback on seed failure without cleanup or sensitive logs', async () => {
		mocks.upsert.mockRejectedValue(new Error('synthetic-secret-driver-error'))
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		expect(mocks.insert).toHaveBeenCalledTimes(1)
		expect(mocks.delete).not.toHaveBeenCalled()
		expect(mocks.info).not.toHaveBeenCalled()
		expect(mocks.warn).toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({ operation: 'read', reason: 'seed-failed' }),
		)
		const logs = JSON.stringify(mocks.warn.mock.calls)
		expect(logs).not.toContain('synthetic-secret-driver-error')
		expect(logs).not.toContain('env-dropbox')
		expect(logs).not.toContain(mocks.values.mock.calls[0]![0].ciphertext)
	})
	it('preserves fallback when seeded logging fails', async () => {
		mocks.info.mockRejectedValue(new Error('log transport down'))
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		expect(mocks.delete).not.toHaveBeenCalled()
		expect(mocks.warn).not.toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({ reason: 'seed-failed' }),
		)
	})
	it('falls back for a bad decrypt or swapped provider', async () => {
		mocks.limit.mockResolvedValue([
			encryptIntegrationToken('youtube_analytics', 'db-token', key),
		])
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		expect(mocks.warn).toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({ reason: 'decrypt-failed' }),
		)
	})
	it.each([{ code: 'ER_NO_SUCH_TABLE' }, { cause: { errno: 1146 } }])(
		'missing table preserves reads and makes writes no-ops',
		async (error) => {
			mocks.limit.mockRejectedValue(error)
			mocks.upsert.mockRejectedValue(error)
			expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
			expect(mocks.insert).not.toHaveBeenCalled()
			await expect(
				putIntegrationRefreshToken('dropbox', 'fresh-token'),
			).resolves.toEqual({ ok: false, staleRow: false })
			expect(mocks.warn).toHaveBeenCalledTimes(2)
			for (const [, data] of mocks.warn.mock.calls)
				expect(data.reason).toBe('no-table')
		},
	)
	it('writes only an authenticated envelope and upserts atomically', async () => {
		expect(await putIntegrationRefreshToken('dropbox', 'fresh-token')).toEqual({
			ok: true,
		})
		const row = mocks.values.mock.calls[0]![0]
		expect(row.provider).toBe('dropbox')
		expect(row.updatedAt).toBeInstanceOf(Date)
		expect(decryptIntegrationToken('dropbox', row, key)).toBe('fresh-token')
		expect(JSON.stringify(row)).not.toContain('fresh-token')
		expect(mocks.upsert).toHaveBeenCalledWith({
			set: expect.objectContaining({ ciphertext: row.ciphertext }),
		})
	})
	it('validates present keys and preserves legacy behavior on invalid configuration', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = 'bad-key'
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		await expect(
			putIntegrationRefreshToken('dropbox', 'fresh-token'),
		).resolves.toEqual({ ok: false, staleRow: false })
		expect(mocks.select).not.toHaveBeenCalled()
		expect(mocks.insert).not.toHaveBeenCalled()
	})
	it('never serializes raw driver errors, including SQL parameters and causes', async () => {
		const secret = 'synthetic-plaintext-refresh-token'
		const ciphertext = 'synthetic-secret-ciphertext'
		const error = Object.assign(
			new Error(`SQL values ${secret} ${ciphertext}`),
			{ cause: new Error(secret), sql: ciphertext },
		)
		mocks.limit.mockRejectedValue(error)
		mocks.upsert.mockRejectedValue(error)
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		await putIntegrationRefreshToken('dropbox', secret)
		const logs = JSON.stringify(mocks.warn.mock.calls)
		expect(logs).not.toContain(secret)
		expect(logs).not.toContain(ciphertext)
		expect(logs).not.toContain(key.toString('base64'))
		expect(logs).toContain('Integration token write: write-failed')
		// Pin why passing the original error through serializeError is forbidden.
		expect(JSON.stringify(serializeError(error))).toContain(secret)
	})
	it('logging failures cannot escape into a callback or reader', async () => {
		mocks.warn.mockRejectedValue(new Error('log transport down'))
		mocks.debug.mockRejectedValue(new Error('log transport down'))
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		await expect(
			putIntegrationRefreshToken('dropbox', 'token'),
		).resolves.toEqual({ ok: true })
	})

	it.each(['dropbox', 'youtube_analytics'] as const)(
		'removes an existing stale %s row after a failed write so fresh env wins',
		async (provider) => {
			let rows = [encryptIntegrationToken(provider, 'old-db-token', key)]
			mocks.limit.mockImplementation(async () => rows)
			mocks.deleteWhere.mockImplementation(async () => {
				rows = []
			})
			expect(await getIntegrationRefreshToken(provider, 'old-env-token')).toBe(
				'old-db-token',
			)
			mocks.upsert.mockRejectedValue(new Error('synthetic write failure'))
			expect(await putIntegrationRefreshToken(provider, 'new-token')).toEqual({
				ok: false,
				staleRow: false,
			})
			expect(mocks.delete).toHaveBeenCalledTimes(1)
			expect(await getIntegrationRefreshToken(provider, 'new-env-token')).toBe(
				'new-env-token',
			)
			expect(mocks.warn).toHaveBeenCalledWith(
				'integration-token.fallback',
				expect.objectContaining({
					message: 'DB token store failed; using env',
				}),
			)
		},
	)

	it('returns failure without throwing when both write and cleanup fail', async () => {
		mocks.upsert.mockRejectedValue(new Error('synthetic write failure'))
		mocks.deleteWhere.mockRejectedValue(new Error('synthetic delete failure'))
		await expect(
			putIntegrationRefreshToken('dropbox', 'token'),
		).resolves.toEqual({ ok: false, staleRow: true })
		expect(mocks.warn).toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({
				reason: 'cleanup-failed',
				message: 'DB token cleanup failed; stale row may remain',
			}),
		)
	})

	it('a missing table during cleanup leaves no stale row', async () => {
		mocks.upsert.mockRejectedValue(new Error('synthetic write failure'))
		mocks.deleteWhere.mockRejectedValue({ code: 'ER_NO_SUCH_TABLE' })
		await expect(
			putIntegrationRefreshToken('dropbox', 'token'),
		).resolves.toEqual({ ok: false, staleRow: false })
		expect(mocks.warn).not.toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({ reason: 'cleanup-failed' }),
		)
	})

	it('maps each put outcome to static operator copy', () => {
		expect(integrationTokenStorageNotice({ ok: true })).toBeNull()
		expect(integrationTokenStorageNotice({ ok: false, staleRow: false })).toBe(
			'DB token store failed; using env.',
		)
		expect(integrationTokenStorageNotice({ ok: false, staleRow: true })).toBe(
			'DB token store failed and a stale DB row may remain; delete it before the next deploy.',
		)
	})
})
