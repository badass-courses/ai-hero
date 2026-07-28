import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deviceFindFirst: vi.fn(),
	env: {
		PERSONAL_ACCESS_TOKEN_SECRET: 'test-personal-access-token-secret' as
			| string
			| undefined,
	},
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	personalAccessTokenFindFirst: vi.fn(),
	update: vi.fn(),
	updateSet: vi.fn(),
	updateWhere: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			deviceAccessToken: { findFirst: mocks.deviceFindFirst },
			personalAccessToken: {
				findFirst: mocks.personalAccessTokenFindFirst,
			},
		},
		update: mocks.update,
	},
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import {
	createPersonalAccessToken,
	hashPersonalAccessTokenSecret,
} from '@/lib/personal-access-tokens'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { buildPersonalAccessTokenAbility } from '@/server/pat-scopes'

const hashSecret = 'test-personal-access-token-secret'
const user = {
	id: 'user_admin',
	email: 'admin@example.com',
	name: 'Admin',
	role: 'admin',
	fields: {},
	roles: [
		{
			role: {
				id: 'role_admin',
				name: 'admin',
				description: null,
				active: true,
			},
		},
	],
}

function request(token?: string) {
	return new NextRequest('http://localhost:3000/api/posts', {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	})
}

function personalAccessTokenFixture() {
	const created = createPersonalAccessToken({
		id: 'pat_1',
		userId: user.id,
		name: 'Content reader',
		scopes: ['content:read'],
		hashSecret,
		publicId: 'public123456789',
		secret: 'secret456789',
	})

	return {
		rawToken: created.rawToken,
		row: { ...created.record, user },
	}
}

describe('getUserAbilityForRequest', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.env.PERSONAL_ACCESS_TOKEN_SECRET = hashSecret
		mocks.deviceFindFirst.mockResolvedValue(null)
		mocks.personalAccessTokenFindFirst.mockResolvedValue(null)
		mocks.update.mockReturnValue({ set: mocks.updateSet })
		mocks.updateSet.mockReturnValue({ where: mocks.updateWhere })
		mocks.updateWhere.mockResolvedValue(undefined)
	})

	it('returns an explicit anonymous auth method without a bearer', async () => {
		const auth = await getUserAbilityForRequest(request())

		expect(auth.authMethod).toBe('anonymous')
		expect(auth.user).toBeNull()
		expect(auth.ability.cannot('read', 'Content')).toBe(true)
	})

	it('builds ability from PAT scopes, not the attributed admin roles', async () => {
		const fixture = personalAccessTokenFixture()
		mocks.personalAccessTokenFindFirst.mockResolvedValue(fixture.row)

		const auth = await getUserAbilityForRequest(request(fixture.rawToken))

		expect(auth.authMethod).toBe('personal-access-token')
		expect(auth.user?.id).toBe(user.id)
		expect(auth.ability.can('read', 'Content')).toBe(true)
		expect(auth.ability.can('read_privileged', 'Content')).toBe(true)
		expect(auth.ability.cannot('create', 'Content')).toBe(true)
		expect(auth.ability.cannot('update', 'Content')).toBe(true)
		expect(auth.ability.cannot('delete', 'Content')).toBe(true)
		expect(auth.ability.cannot('manage', 'all')).toBe(true)
		expect(mocks.updateSet).toHaveBeenCalledWith({
			lastUsedAt: expect.any(Date),
		})
		expect(mocks.updateWhere).toHaveBeenCalledOnce()
		expect(mocks.log.info).toHaveBeenCalledWith(
			'auth.personal-access-token.verify',
			{
				tokenKind: 'personal-access-token',
				publicIdPrefix: 'public12',
				scopes: ['content:read'],
				outcome: 'accepted',
			},
		)
		expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(
			fixture.rawToken,
		)
	})

	it('requires the Bearer scheme for PATs without changing device-token parsing', async () => {
		const fixture = personalAccessTokenFixture()

		const auth = await getUserAbilityForRequest(
			new NextRequest('http://localhost:3000/api/posts', {
				headers: { Authorization: `Basic ${fixture.rawToken}` },
			}),
		)

		expect(auth.authMethod).toBe('anonymous')
		expect(mocks.personalAccessTokenFindFirst).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'auth.personal-access-token.verify',
			expect.objectContaining({ outcome: 'denied:invalid-scheme' }),
		)
	})

	it('denies and safely logs a wrong PAT secret', async () => {
		const fixture = personalAccessTokenFixture()
		mocks.personalAccessTokenFindFirst.mockResolvedValue({
			...fixture.row,
			tokenHash: hashPersonalAccessTokenSecret('different-secret', hashSecret),
		})

		const auth = await getUserAbilityForRequest(request(fixture.rawToken))

		expect(auth.authMethod).toBe('anonymous')
		expect(auth.user).toBeNull()
		expect(mocks.update).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'auth.personal-access-token.verify',
			expect.objectContaining({
				publicIdPrefix: 'public12',
				outcome: 'denied:wrong-hash',
			}),
		)
		expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain(
			fixture.rawToken,
		)
	})

	it.each([
		[
			'revoked',
			{ revokedAt: new Date('2026-07-17T12:00:00.000Z') },
			'denied:revoked',
		],
		[
			'expired',
			{ expiresAt: new Date('2020-07-17T12:00:00.000Z') },
			'denied:expired',
		],
		[
			'missing content scope',
			{ scopes: ['analytics:read'] },
			'denied:missing-scope',
		],
	] as const)('denies and logs %s PATs', async (_label, overrides, outcome) => {
		const fixture = personalAccessTokenFixture()
		mocks.personalAccessTokenFindFirst.mockResolvedValue({
			...fixture.row,
			...overrides,
		})

		const auth = await getUserAbilityForRequest(request(fixture.rawToken))

		expect(auth.authMethod).toBe('anonymous')
		expect(mocks.update).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'auth.personal-access-token.verify',
			expect.objectContaining({ outcome }),
		)
	})

	it('logs an unknown PAT without leaking its secret', async () => {
		const fixture = personalAccessTokenFixture()

		const auth = await getUserAbilityForRequest(request(fixture.rawToken))

		expect(auth.authMethod).toBe('anonymous')
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'auth.personal-access-token.verify',
			expect.objectContaining({ outcome: 'denied:malformed' }),
		)
		expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain(
			fixture.rawToken,
		)
	})

	it('guards an undefined PAT hash secret outside production', async () => {
		const fixture = personalAccessTokenFixture()
		mocks.personalAccessTokenFindFirst.mockResolvedValue(fixture.row)
		mocks.env.PERSONAL_ACCESS_TOKEN_SECRET = undefined

		const auth = await getUserAbilityForRequest(request(fixture.rawToken))

		expect(auth.authMethod).toBe('anonymous')
		expect(mocks.update).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'auth.personal-access-token.verify',
			expect.objectContaining({ outcome: 'denied:missing-secret' }),
		)
	})

	it('keeps the existing device-token role-derived ability path', async () => {
		mocks.deviceFindFirst.mockResolvedValue({
			token: 'device-token',
			createdAt: new Date(),
			verifiedBy: user,
		})

		const auth = await getUserAbilityForRequest(request('device-token'))

		expect(auth.authMethod).toBe('device-token')
		expect(auth.user?.id).toBe(user.id)
		expect(auth.ability.can('manage', 'all')).toBe(true)
		expect(auth.ability.can('read_privileged', 'Content')).toBe(true)
		expect(mocks.personalAccessTokenFindFirst).not.toHaveBeenCalled()
	})
})

describe('personal access token scope registry', () => {
	it('keeps dormant analytics scopes from granting content or admin access', () => {
		const ability = buildPersonalAccessTokenAbility([
			'analytics:read',
			'analytics:chat',
		])

		expect(ability.cannot('read', 'Content')).toBe(true)
		expect(ability.cannot('read_privileged', 'Content')).toBe(true)
		expect(ability.cannot('manage', 'all')).toBe(true)
	})
})
