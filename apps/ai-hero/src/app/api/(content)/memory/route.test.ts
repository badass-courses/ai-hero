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

const storeBody = (body: Record<string, unknown>) =>
	(POST as any)(
		new NextRequest('https://www.aihero.dev/api/memory', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	)

describe('/api/memory store, keyword-only collection', () => {
	beforeEach(() => mocks.auth.mockResolvedValue(admin))

	it('redacts customer emails and Front ids, keeps our own domains', async () => {
		const res = await storeBody({
			observation:
				'Buyer jane.doe@example.com in cnv_1abc23 (msg_9xyz8) was helped by support@aihero.dev',
			category: 'resolution-pattern',
			source: 'front cnv_1abc23 from jane.doe@example.com',
		})
		expect(res.status).toBe(200)
		const doc = mocks.create.mock.calls[0]![0]
		expect(doc.observation).toBe(
			'Buyer [customer email] in [conversation] ([message]) was helped by support@aihero.dev',
		)
		expect(doc.source).toBe('front [conversation] from [customer email]')
		expect(JSON.stringify(doc)).not.toMatch(/example\.com|cnv_|msg_/)
	})

	it('refuses customer-context notes without writing', async () => {
		const res = await storeBody({
			observation: 'Jane prefers invoices in EUR',
			category: 'customer-context',
		})
		expect(res.status).toBe(422)
		expect(mocks.create).not.toHaveBeenCalled()
	})

	it('never queries the dropped embedding field', async () => {
		await storeBody({ observation: 'x', category: 'process' })
		await (GET as any)(
			new NextRequest('https://www.aihero.dev/api/memory?q=x&semantic=true'),
		)
		for (const [params] of mocks.search.mock.calls) {
			expect(JSON.stringify(params)).not.toContain('embedding')
		}
		expect(mocks.create).toHaveBeenCalledTimes(1)
	})
})
