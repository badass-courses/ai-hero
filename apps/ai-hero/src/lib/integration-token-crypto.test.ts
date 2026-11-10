import { describe, expect, it } from 'vitest'
import {
	decryptIntegrationToken,
	encryptIntegrationToken,
	integrationTokenKey,
} from './integration-token-crypto'

const key = integrationTokenKey(Buffer.alloc(32, 7).toString('base64'))
const token = 'synthetic-refresh-token'

describe('integration token encryption', () => {
	it('round trips, fingerprints without plaintext, and uses fresh 96-bit IVs', () => {
		const row = encryptIntegrationToken('dropbox', token, key)
		expect(decryptIntegrationToken('dropbox', row, key)).toBe(token)
		expect(row.fingerprint).toMatch(/^[a-f0-9]{12}$/)
		expect(Buffer.from(row.iv, 'base64')).toHaveLength(12)
		expect(row.iv).not.toBe(encryptIntegrationToken('dropbox', token, key).iv)
		expect(JSON.stringify(row)).not.toContain(token)
	})
	it.each(['ciphertext', 'iv', 'authTag'] as const)(
		'rejects tampered %s',
		(field) => {
			const row = encryptIntegrationToken('dropbox', token, key)
			const bytes = Buffer.from(row[field], 'base64')
			bytes[0] = bytes[0]! ^ 1
			row[field] = bytes.toString('base64')
			expect(() => decryptIntegrationToken('dropbox', row, key)).toThrow()
		},
	)
	it('binds AAD to the provider and rejects a wrong key or envelope version', () => {
		const row = encryptIntegrationToken('dropbox', token, key)
		expect(() =>
			decryptIntegrationToken('youtube_analytics', row, key),
		).toThrow()
		expect(() =>
			decryptIntegrationToken('dropbox', row, Buffer.alloc(32, 8)),
		).toThrow()
		expect(() =>
			decryptIntegrationToken('dropbox', { ...row, keyVersion: 2 }, key),
		).toThrow()
	})
	it.each([
		'',
		'not-base64',
		Buffer.alloc(31).toString('base64'),
		Buffer.alloc(33).toString('base64'),
	])('rejects invalid keys', (value) => {
		expect(() => integrationTokenKey(value)).toThrow(
			'32 bytes encoded as base64',
		)
	})
})
