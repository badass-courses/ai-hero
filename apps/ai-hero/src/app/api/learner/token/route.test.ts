import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	insertValues: vi.fn(),
	findMany: vi.fn(),
	updateWhere: vi.fn(),
	updateSet: vi.fn(),
}))

vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/db', () => ({
	db: {
		insert: () => ({ values: mocks.insertValues }),
		query: { deviceAccessToken: { findMany: mocks.findMany } },
		update: () => ({
			set: (values: unknown) => (
				mocks.updateSet(values),
				{ where: mocks.updateWhere }
			),
		}),
	},
}))
vi.mock('@/db/schema', () => ({
	deviceAccessToken: {
		token: 'token',
		userId: 'userId',
		scope: 'scope',
		revokedAt: 'revokedAt',
	},
}))

import { learnerTokenId } from '@/lib/learner-agent/identity'

import { DELETE, GET, POST } from './route'

const signedIn = (id: string | null) =>
	mocks.session.mockResolvedValue({
		session: id ? { user: { id } } : null,
		ability: {},
	})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.insertValues.mockResolvedValue(undefined)
	mocks.updateWhere.mockResolvedValue(undefined)
})

describe('/api/learner/token', () => {
	it('needs a signed-in learner for every method', async () => {
		signedIn(null)
		expect((await POST()).status).toBe(401)
		expect((await GET()).status).toBe(401)
		expect(
			(
				await DELETE(
					new Request('https://aihero.test', { method: 'DELETE', body: '{}' }),
				)
			).status,
		).toBe(401)
	})

	it('mints a learner:read token for the caller, shown once, with a 90-day expiry', async () => {
		signedIn('u1')
		const response = await POST()
		const body = await response.json()
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u1',
				scope: 'learner:read',
				token: body.token,
				revokedAt: null,
			}),
		)
		expect(body.id).toBe(learnerTokenId(body.token))
		expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(
			89 * 24 * 3600_000,
		)
	})

	it('lists the caller’s learner tokens without the raw tokens', async () => {
		signedIn('u1')
		mocks.findMany.mockResolvedValue([
			{
				token: 'raw-secret-1',
				scope: 'learner:read',
				createdAt: new Date('2026-10-01'),
				expiresAt: new Date('2027-01-01'),
				revokedAt: null,
			},
		])
		const body = await (await GET()).json()
		expect(body.tokens).toEqual([
			{
				id: learnerTokenId('raw-secret-1'),
				scope: 'learner:read',
				createdAt: '2026-10-01T00:00:00.000Z',
				expiresAt: '2027-01-01T00:00:00.000Z',
				revokedAt: null,
			},
		])
		expect(JSON.stringify(body)).not.toContain('raw-secret')
	})

	it('revokes only one of the caller’s own tokens', async () => {
		signedIn('u1')
		mocks.findMany.mockResolvedValue([{ token: 'raw-secret-1' }])

		const missing = await DELETE(
			new Request('https://aihero.test', {
				method: 'DELETE',
				body: JSON.stringify({ id: learnerTokenId('someone-else') }),
			}),
		)
		expect(missing.status).toBe(404)
		expect(mocks.updateWhere).not.toHaveBeenCalled()

		const revoked = await DELETE(
			new Request('https://aihero.test', {
				method: 'DELETE',
				body: JSON.stringify({ id: learnerTokenId('raw-secret-1') }),
			}),
		)
		expect(revoked.status).toBe(200)
		expect(mocks.updateSet).toHaveBeenCalledWith({
			revokedAt: expect.any(Date),
		})
	})
})
