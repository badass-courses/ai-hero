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
	warn: vi.fn(),
	dbLoaded: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/server/logger', async () => ({
	log: { warn: mocks.warn },
	serializeError: (await import('@/server/logger-utils')).serializeError,
}))
vi.mock('@/db', () => {
	mocks.dbLoaded()
	return { db: { select: mocks.select, insert: mocks.insert } }
})
import {
	getIntegrationRefreshToken,
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
		mocks.warn.mockResolvedValue(undefined)
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
		await putIntegrationRefreshToken('dropbox', 'fresh-token')
		await putIntegrationRefreshToken('youtube_analytics', 'fresh-token')
		expect(mocks.dbLoaded).not.toHaveBeenCalled()
		expect(mocks.select).not.toHaveBeenCalled()
		expect(mocks.insert).not.toHaveBeenCalled()
		expect(mocks.warn).toHaveBeenCalledWith(
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
			expect(mocks.warn).not.toHaveBeenCalled()
		},
	)
	it('falls back for a missing row', async () => {
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		expect(mocks.warn).toHaveBeenCalledWith(
			'integration-token.fallback',
			expect.objectContaining({ reason: 'no-row' }),
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
			await expect(
				putIntegrationRefreshToken('dropbox', 'fresh-token'),
			).resolves.toBeUndefined()
			expect(mocks.warn).toHaveBeenCalledTimes(2)
			for (const [, data] of mocks.warn.mock.calls)
				expect(data.reason).toBe('no-table')
		},
	)
	it('writes only an authenticated envelope and upserts atomically', async () => {
		await putIntegrationRefreshToken('dropbox', 'fresh-token')
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
		).resolves.toBeUndefined()
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
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		expect(await getIntegrationRefreshToken('dropbox')).toBe('env-dropbox')
		await expect(
			putIntegrationRefreshToken('dropbox', 'token'),
		).resolves.toBeUndefined()
	})
})
