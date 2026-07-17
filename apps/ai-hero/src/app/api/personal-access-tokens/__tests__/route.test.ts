import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	insert: vi.fn(),
	insertValues: vi.fn(),
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	update: vi.fn(),
	updateSet: vi.fn(),
	updateWhere: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {
		insert: mocks.insert,
		query: {
			personalAccessToken: {
				findFirst: mocks.findFirst,
				findMany: mocks.findMany,
			},
		},
		update: mocks.update,
	},
}))
vi.mock('@/env.mjs', () => ({
	env: { PERSONAL_ACCESS_TOKEN_SECRET: 'test-personal-access-token-secret' },
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { DELETE } from '../[id]/route'
import { GET, POST } from '../route'

const baseUrl = 'http://localhost:3000/api/personal-access-tokens'
const adminUser = { id: 'user_admin', email: 'admin@example.com' }

function auth(canManage: boolean) {
	return {
		user: adminUser,
		ability: {
			can: vi.fn(
				(action: string, subject: string) =>
					canManage && action === 'manage' && subject === 'all',
			),
		},
	}
}

function postRequest(body: unknown) {
	return new NextRequest(baseUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

function tokenRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'pat_1',
		userId: adminUser.id,
		name: 'Content reader',
		publicId: 'public123456789',
		tokenPrefix: 'aih_pat_public123456789',
		tokenHash: 'must-never-leak',
		scopes: ['content:read'],
		createdAt: new Date('2026-07-17T12:00:00.000Z'),
		lastUsedAt: null,
		expiresAt: null,
		revokedAt: null,
		updatedAt: new Date('2026-07-17T12:00:00.000Z'),
		...overrides,
	}
}

describe('personal access token API', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.insert.mockReturnValue({ values: mocks.insertValues })
		mocks.insertValues.mockResolvedValue(undefined)
		mocks.update.mockReturnValue({ set: mocks.updateSet })
		mocks.updateSet.mockReturnValue({ where: mocks.updateWhere })
		mocks.updateWhere.mockResolvedValue(undefined)
	})

	it('mints a token once for an admin and persists only the record', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(true))

		const response = await POST(
			postRequest({
				name: 'Content reader',
				scopes: ['content:read'],
				expiresAt: '2099-07-17T12:00:00.000Z',
			}),
		)
		const body = await response.json()

		expect(response.status).toBe(201)
		expect(body.token).toMatch(/^aih_pat_[a-f0-9]+_[a-f0-9]+$/)
		expect(body).not.toHaveProperty('tokenHash')
		expect(mocks.insertValues).toHaveBeenCalledOnce()
		const persisted = mocks.insertValues.mock.calls[0]?.[0]
		expect(persisted).toMatchObject({
			userId: adminUser.id,
			name: 'Content reader',
			scopes: ['content:read'],
		})
		expect(persisted).toHaveProperty('tokenHash')
		expect(JSON.stringify(persisted)).not.toContain(body.token)
	})

	it('rejects unknown scopes', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(true))

		const response = await POST(
			postRequest({ name: 'Bad scope', scopes: ['content:write'] }),
		)

		expect(response.status).toBe(400)
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})

	it('rejects authenticated non-admin callers', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(false))

		const response = await POST(
			postRequest({ name: 'Content reader', scopes: ['content:read'] }),
		)

		expect(response.status).toBe(403)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'api.personal-access-tokens.access-denied',
			expect.objectContaining({ action: 'mint', outcome: 'forbidden' }),
		)
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})

	it('rejects anonymous callers', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: null,
			ability: { can: vi.fn(() => false) },
		})

		const response = await POST(
			postRequest({ name: 'Content reader', scopes: ['content:read'] }),
		)

		expect(response.status).toBe(401)
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})

	it('never leaks token hashes when listing the caller tokens', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(true))
		mocks.findMany.mockResolvedValue([
			{ ...tokenRow(), rawToken: 'aih_pat_public_secret' },
		])

		const response = await GET(new NextRequest(baseUrl))
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body).toEqual([
			{
				id: 'pat_1',
				name: 'Content reader',
				tokenPrefix: 'aih_pat_public123456789',
				scopes: ['content:read'],
				createdAt: '2026-07-17T12:00:00.000Z',
				lastUsedAt: null,
				expiresAt: null,
				revokedAt: null,
			},
		])
		expect(JSON.stringify(body)).not.toContain('must-never-leak')
		expect(JSON.stringify(body)).not.toContain('aih_pat_public_secret')
	})

	it('revokes only once and returns an already-revoked token state unchanged', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(true))
		const existingRevokedAt = new Date('2026-07-17T13:00:00.000Z')
		mocks.findFirst
			.mockResolvedValueOnce(tokenRow())
			.mockResolvedValueOnce(tokenRow({ revokedAt: existingRevokedAt }))
		const request = new NextRequest(`${baseUrl}/pat_1`, { method: 'DELETE' })
		const context = { params: Promise.resolve({ id: 'pat_1' }) }

		const firstResponse = await DELETE(request, context)
		const firstBody = await firstResponse.json()
		const secondResponse = await DELETE(request, context)
		const secondBody = await secondResponse.json()

		expect(firstResponse.status).toBe(200)
		expect(firstBody.revokedAt).toEqual(expect.any(String))
		expect(secondResponse.status).toBe(200)
		expect(secondBody.revokedAt).toBe(existingRevokedAt.toISOString())
		expect(mocks.updateWhere).toHaveBeenCalledOnce()
		expect(secondBody).not.toHaveProperty('tokenHash')
	})

	it('rejects expiration dates in the past', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(auth(true))

		const response = await POST(
			postRequest({
				name: 'Expired before mint',
				scopes: ['content:read'],
				expiresAt: '2020-01-01T00:00:00.000Z',
			}),
		)

		expect(response.status).toBe(400)
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})
})
