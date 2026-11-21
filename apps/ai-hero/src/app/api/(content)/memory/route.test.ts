import { createMongoAbility } from '@casl/ability'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	search: vi.fn(),
	create: vi.fn(),
	logError: vi.fn(),
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.auth,
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.logError } }))
vi.mock('typesense', () => ({
	default: {
		Client: class {
			collections() {
				return {
					documents: () => ({ search: mocks.search, create: mocks.create }),
				}
			}
		},
	},
}))

import { GET, OPTIONS, POST } from './route'

const anonymous = {
	user: null,
	ability: createMongoAbility([]),
	authMethod: 'anonymous',
}
const learner = {
	user: { id: 'u1' },
	ability: createMongoAbility([{ action: 'view', subject: 'Analytics' }]),
	authMethod: 'device-token',
}
const admin = {
	user: { id: 'admin' },
	ability: createMongoAbility([{ action: 'manage', subject: 'all' }]),
	authMethod: 'device-token',
}

const recall = () =>
	(GET as any)(new NextRequest('https://www.aihero.dev/api/memory?q=*'))
const store = () =>
	(POST as any)(
		new NextRequest('https://www.aihero.dev/api/memory', {
			method: 'POST',
			body: JSON.stringify({ observation: 'x', category: 'process' }),
		}),
	)

beforeEach(() => {
	vi.clearAllMocks()
	process.env.NEXT_PUBLIC_TYPESENSE_HOST = 'typesense.example.test'
	process.env.TYPESENSE_WRITE_API_KEY = 'test-key'
	mocks.search.mockResolvedValue({ found: 0, hits: [] })
	mocks.create.mockResolvedValue({})
})

describe('/api/memory', () => {
	it.each([
		['anonymous', anonymous, 401],
		['non-admin device token', learner, 403],
		[
			'personal access token',
			{ ...learner, authMethod: 'personal-access-token' },
			403,
		],
	])(
		'refuses %s on GET and POST without touching the store',
		async (_n, who, status) => {
			mocks.auth.mockResolvedValue(who)
			expect((await recall()).status).toBe(status)
			expect((await store()).status).toBe(status)
			expect(mocks.search).not.toHaveBeenCalled()
			expect(mocks.create).not.toHaveBeenCalled()
		},
	)

	it('lets an admin recall', async () => {
		mocks.auth.mockResolvedValue(admin)
		const res = await recall()
		expect(res.status).toBe(200)
		expect(mocks.search).toHaveBeenCalledTimes(1)
	})

	it('sends no wildcard CORS header', async () => {
		mocks.auth.mockResolvedValue(anonymous)
		expect(
			(await recall()).headers.get('access-control-allow-origin'),
		).toBeNull()
		expect(
			(await OPTIONS()).headers.get('access-control-allow-origin'),
		).toBeNull()
	})

	it('does not echo provider errors to the caller', async () => {
		mocks.auth.mockResolvedValue(admin)
		mocks.search.mockRejectedValue(new Error('typesense secret host detail'))
		const res = await recall()
		expect(res.status).toBe(500)
		expect(JSON.stringify(await res.json())).not.toContain('secret host detail')
		expect(mocks.logError).toHaveBeenCalled()
	})
})
