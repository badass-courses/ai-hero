import { beforeEach, describe, expect, it, vi } from 'vitest'
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
	dbLoaded: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, warn: mocks.warn, debug: mocks.debug },
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
const providers = ['dropbox', 'youtube_analytics'] as const

describe('DB-only integration token store', () => {
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
	})

	it.each(providers)('returns the decrypted DB row for %s', async (provider) => {
		mocks.limit.mockResolvedValue([
			encryptIntegrationToken(provider, 'db-token', key),
		])
		expect(await getIntegrationRefreshToken(provider)).toBe('db-token')
		expect(mocks.insert).not.toHaveBeenCalled()
		expect(mocks.warn).not.toHaveBeenCalled()
	})

	it('without a key returns undefined, ignores env and never loads the DB', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		for (const provider of providers)
			expect(await getIntegrationRefreshToken(provider)).toBeUndefined()
		expect(mocks.dbLoaded).not.toHaveBeenCalled()
		expect(mocks.select).not.toHaveBeenCalled()
		expect(mocks.debug).toHaveBeenCalledWith('integration-token.missing', {
			provider: 'dropbox',
			operation: 'read',
			reason: 'no-key',
		})
	})

	it.each(providers)('with no row returns undefined and never seeds (%s)', async (provider) => {
		expect(await getIntegrationRefreshToken(provider)).toBeUndefined()
		expect(mocks.insert).not.toHaveBeenCalled()
		expect(mocks.info).not.toHaveBeenCalled()
		expect(mocks.warn).toHaveBeenCalledWith('integration-token.missing', {
			provider,
			operation: 'read',
			reason: 'no-row',
		})
	})

	it('returns undefined for a bad decrypt or swapped provider', async () => {
		mocks.limit.mockResolvedValue([
			encryptIntegrationToken('youtube_analytics', 'db-token', key),
		])
		expect(await getIntegrationRefreshToken('dropbox')).toBeUndefined()
		expect(mocks.warn).toHaveBeenCalledWith(
			'integration-token.missing',
			expect.objectContaining({ reason: 'decrypt-failed' }),
		)
	})

	it('returns undefined on a read failure without logging the driver error', async () => {
		mocks.limit.mockRejectedValue(new Error('synthetic-secret-driver-error'))
		expect(await getIntegrationRefreshToken('dropbox')).toBeUndefined()
		expect(mocks.warn).toHaveBeenCalledWith('integration-token.missing', {
			provider: 'dropbox',
			operation: 'read',
			reason: 'read-failed',
		})
		expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(
			'synthetic-secret-driver-error',
		)
	})

	it.each([{ code: 'ER_NO_SUCH_TABLE' }, { cause: { errno: 1146 } }])(
		'a missing table reads undefined and fails writes visibly',
		async (error) => {
			mocks.limit.mockRejectedValue(error)
			mocks.upsert.mockRejectedValue(error)
			expect(await getIntegrationRefreshToken('dropbox')).toBeUndefined()
			await expect(
				putIntegrationRefreshToken('dropbox', 'fresh-token'),
			).resolves.toEqual({ ok: false })
			for (const [, data] of mocks.warn.mock.calls)
				expect(data.reason).toBe('no-table')
		},
	)

	it('an invalid key reads undefined and fails writes', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = 'bad-key'
		expect(await getIntegrationRefreshToken('dropbox')).toBeUndefined()
		await expect(
			putIntegrationRefreshToken('dropbox', 'fresh-token'),
		).resolves.toEqual({ ok: false })
		expect(mocks.select).not.toHaveBeenCalled()
		expect(mocks.insert).not.toHaveBeenCalled()
	})

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
		expect(mocks.delete).not.toHaveBeenCalled()
	})

	it('a put with no key fails visibly and writes nothing', async () => {
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		await expect(
			putIntegrationRefreshToken('dropbox', 'fresh-token'),
		).resolves.toEqual({ ok: false })
		expect(mocks.insert).not.toHaveBeenCalled()
	})

	it('never logs driver errors, SQL parameters or token values', async () => {
		const secret = 'synthetic-plaintext-refresh-token'
		const ciphertext = 'synthetic-secret-ciphertext'
		const error = Object.assign(
			new Error(`SQL values ${secret} ${ciphertext}`),
			{ cause: new Error(secret), sql: ciphertext },
		)
		mocks.limit.mockRejectedValue(error)
		mocks.upsert.mockRejectedValue(error)
		await getIntegrationRefreshToken('dropbox')
		await putIntegrationRefreshToken('dropbox', secret)
		const logs = JSON.stringify(mocks.warn.mock.calls)
		expect(logs).not.toContain(secret)
		expect(logs).not.toContain(ciphertext)
		expect(logs).not.toContain(key.toString('base64'))
		expect(mocks.warn).toHaveBeenCalledWith('integration-token.write-failed', {
			provider: 'dropbox',
			operation: 'write',
			reason: 'write-failed',
		})
	})

	it('logging failures cannot escape into a callback or reader', async () => {
		mocks.warn.mockRejectedValue(new Error('log transport down'))
		mocks.debug.mockRejectedValue(new Error('log transport down'))
		mocks.env.INTEGRATION_TOKEN_KEY = undefined
		expect(await getIntegrationRefreshToken('dropbox')).toBeUndefined()
		await expect(
			putIntegrationRefreshToken('dropbox', 'token'),
		).resolves.toEqual({ ok: false })
	})

	it('maps each put outcome to static operator copy', () => {
		expect(integrationTokenStorageNotice({ ok: true })).toBeNull()
		const notice = integrationTokenStorageNotice({ ok: false })
		expect(notice).toContain('could not be saved')
		expect(notice).not.toContain('env')
	})
})
