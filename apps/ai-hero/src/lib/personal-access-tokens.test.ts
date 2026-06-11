import { describe, expect, it } from 'vitest'

import {
	ANALYTICS_READ_SCOPE,
	createPersonalAccessToken,
	hashPersonalAccessTokenSecret,
	parsePersonalAccessToken,
	verifyPersonalAccessToken,
	type PersonalAccessTokenRecord,
} from './personal-access-tokens'

const hashSecret = 'test-hash-secret'
const now = new Date('2026-05-19T12:00:00.000Z')

function createTestToken(
	overrides: {
		record?: Partial<PersonalAccessTokenRecord>
		scopes?: PersonalAccessTokenRecord['scopes']
		expiresAt?: Date | null
	} = {},
) {
	const created = createPersonalAccessToken({
		id: 'pat_test_123',
		userId: 'user_test_123',
		name: 'Analytics API token',
		scopes: (overrides.scopes ?? [ANALYTICS_READ_SCOPE]) as Array<
			typeof ANALYTICS_READ_SCOPE
		>,
		hashSecret,
		expiresAt: overrides.expiresAt ?? new Date('2026-06-19T12:00:00.000Z'),
		now,
		publicId: 'public123',
		secret: 'secret456',
	})

	return {
		...created,
		record: {
			...created.record,
			...overrides.record,
		},
	}
}

describe('personal access tokens', () => {
	it('creates a PAT-shaped raw token and stores only safe metadata plus hash', () => {
		const { rawToken, record } = createTestToken()

		expect(rawToken).toBe('aih_pat_public123_secret456')
		expect(record.publicId).toBe('public123')
		expect(record.tokenPrefix).toBe('aih_pat_public123')
		expect(record.tokenHash).toBe(
			hashPersonalAccessTokenSecret('secret456', hashSecret),
		)
		expect(JSON.stringify(record)).not.toContain(rawToken)
		expect(JSON.stringify(record)).not.toContain('secret456')
	})

	it('parses valid PATs', () => {
		expect(parsePersonalAccessToken('aih_pat_public123_secret456')).toEqual({
			publicId: 'public123',
			secret: 'secret456',
			tokenPrefix: 'aih_pat_public123',
		})
	})

	it('rejects malformed PATs', () => {
		expect(parsePersonalAccessToken('not-a-token')).toBeNull()
		expect(parsePersonalAccessToken('aih_pat_public123')).toBeNull()
		expect(
			parsePersonalAccessToken('aih_pat_public123_secret456_extra'),
		).toBeNull()
		expect(parsePersonalAccessToken('other_pat_public123_secret456')).toBeNull()
		expect(parsePersonalAccessToken('aih_pat_public_123_secret456')).toBeNull()
	})

	it('verifies a valid PAT with the required scope', () => {
		const { rawToken, record } = createTestToken()

		expect(
			verifyPersonalAccessToken({
				rawToken,
				record,
				requiredScope: ANALYTICS_READ_SCOPE,
				hashSecret,
				now,
			}),
		).toEqual({ ok: true, record })
	})

	it('rejects expired PATs', () => {
		const { rawToken, record } = createTestToken({
			expiresAt: new Date('2026-05-19T11:59:59.000Z'),
		})

		expect(
			verifyPersonalAccessToken({
				rawToken,
				record,
				requiredScope: ANALYTICS_READ_SCOPE,
				hashSecret,
				now,
			}),
		).toEqual({ ok: false, reason: 'expired' })
	})

	it('rejects revoked PATs', () => {
		const { rawToken, record } = createTestToken({
			record: { revokedAt: now },
		})

		expect(
			verifyPersonalAccessToken({
				rawToken,
				record,
				requiredScope: ANALYTICS_READ_SCOPE,
				hashSecret,
				now,
			}),
		).toEqual({ ok: false, reason: 'revoked' })
	})

	it('rejects PATs without the required scope', () => {
		const { rawToken, record } = createTestToken({
			scopes: ['content:read'],
		})

		expect(
			verifyPersonalAccessToken({
				rawToken,
				record,
				requiredScope: ANALYTICS_READ_SCOPE,
				hashSecret,
				now,
			}),
		).toEqual({ ok: false, reason: 'missing-scope' })
	})

	it('rejects PATs with a mismatched record public id', () => {
		const { rawToken, record } = createTestToken({
			record: { publicId: 'otherpublic' },
		})

		expect(
			verifyPersonalAccessToken({
				rawToken,
				record,
				requiredScope: ANALYTICS_READ_SCOPE,
				hashSecret,
				now,
			}),
		).toEqual({ ok: false, reason: 'mismatched-id' })
	})

	it('rejects PATs with the wrong hash', () => {
		const { rawToken, record } = createTestToken({
			record: { tokenHash: hashPersonalAccessTokenSecret('other', hashSecret) },
		})

		expect(
			verifyPersonalAccessToken({
				rawToken,
				record,
				requiredScope: ANALYTICS_READ_SCOPE,
				hashSecret,
				now,
			}),
		).toEqual({ ok: false, reason: 'wrong-hash' })
	})
})
