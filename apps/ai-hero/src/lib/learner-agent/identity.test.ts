import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: { query: { deviceAccessToken: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/db/schema', () => ({
	deviceAccessToken: { token: Symbol('token') },
}))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, warn: mocks.warn },
}))

import {
	learnerFromToken,
	learnerTokenId,
	resolveBearer,
	resolveLearner,
} from './identity'

const now = Date.parse('2026-10-29T00:00:00.000Z')
const active = {
	createdAt: new Date(now - 1000),
	expiresAt: new Date(now + 60_000),
	revokedAt: null,
}

const request = (authorization?: string) =>
	new Request('https://aihero.test/mcp', {
		method: 'POST',
		headers: authorization ? { Authorization: authorization } : {},
	})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('which tokens may act as a learner', () => {
	it.each([
		[
			'a learner token',
			'learner:read',
			{ userId: 'u1', tokenKind: 'learner-token' },
		],
		[
			'an unscoped device token, reduced to learner reads',
			null,
			{ userId: 'u1', tokenKind: 'device-token' },
		],
		['an analytics token', 'analytics:read', null],
		['an unknown scope', 'admin:all', null],
	] as const)('%s', (_, scope, expected) => {
		expect(learnerFromToken({ userId: 'u1', scope, ...active }, now)).toEqual(
			expected,
		)
	})

	it('refuses revoked and expired tokens', () => {
		expect(
			learnerFromToken(
				{
					userId: 'u1',
					scope: 'learner:read',
					...active,
					revokedAt: new Date(now),
				},
				now,
			),
		).toBeNull()
		expect(
			learnerFromToken(
				{
					userId: 'u1',
					scope: 'learner:read',
					...active,
					expiresAt: new Date(now - 1),
				},
				now,
			),
		).toBeNull()
	})
})

describe('resolveLearner', () => {
	it('is anonymous without a bearer token', async () => {
		expect(await resolveLearner(request())).toBeNull()
		expect(await resolveLearner(request('Basic abc'))).toBeNull()
		expect(mocks.findFirst).not.toHaveBeenCalled()
	})

	it('refuses PATs without a lookup', async () => {
		expect(await resolveLearner(request('Bearer aih_pat_abc_def'))).toBeNull()
		expect(mocks.findFirst).not.toHaveBeenCalled()
		expect(mocks.warn).toHaveBeenCalledWith(
			'learner_agent.auth',
			expect.objectContaining({ outcome: 'denied:pat' }),
		)
	})

	it('returns only the user id and token kind, and logs the kind without an email', async () => {
		mocks.findFirst.mockResolvedValue({
			userId: 'u1',
			scope: null,
			createdAt: new Date(),
			expiresAt: null,
			revokedAt: null,
		})
		expect(await resolveLearner(request('Bearer device-token'))).toEqual({
			userId: 'u1',
			tokenKind: 'device-token',
		})
		expect(mocks.info).toHaveBeenCalledWith('learner_agent.auth', {
			outcome: 'accepted',
			userId: 'u1',
			tokenKind: 'device-token',
		})
		expect(JSON.stringify(mocks.info.mock.calls)).not.toMatch(/@/)
	})

	it('names a token by a short hash, never the token', () => {
		const id = learnerTokenId('secret-token')
		expect(id).toMatch(/^[0-9a-f]{16}$/)
		expect(id).not.toContain('secret')
	})
})

describe('resolveBearer', () => {
	it('tells no token apart from a bad one, so /mcp can answer 401', async () => {
		expect(await resolveBearer(request())).toEqual({ kind: 'anonymous' })
		expect(await resolveBearer(request('Basic abc'))).toEqual({
			kind: 'anonymous',
		})

		mocks.findFirst.mockResolvedValue(undefined)
		expect(await resolveBearer(request('Bearer unknown'))).toEqual({
			kind: 'invalid',
		})
		expect(await resolveBearer(request('Bearer aih_pat_abc_def'))).toEqual({
			kind: 'invalid',
		})

		for (const row of [
			{ scope: 'learner:read', ...active, revokedAt: new Date() },
			{ scope: 'learner:read', ...active, expiresAt: new Date(Date.now() - 1) },
			{
				scope: 'analytics:read',
				...active,
				expiresAt: new Date(Date.now() + 60_000),
			},
		]) {
			mocks.findFirst.mockResolvedValue({ userId: 'u1', ...row })
			expect(await resolveBearer(request('Bearer t'))).toEqual({
				kind: 'invalid',
			})
		}

		mocks.findFirst.mockResolvedValue({
			userId: 'u1',
			scope: 'learner:read',
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			revokedAt: null,
		})
		expect(await resolveBearer(request('Bearer t'))).toEqual({
			kind: 'learner',
			learner: { userId: 'u1', tokenKind: 'learner-token' },
		})
	})
})
