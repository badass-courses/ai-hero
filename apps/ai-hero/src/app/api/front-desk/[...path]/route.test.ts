import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: { FRONT_DESK_API_KEY: undefined as string | undefined },
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('../hooks', () => ({
	hooks: {
		customerByEmail: async () => ({
			id: 'test-user',
			email: 'test@example.invalid',
			name: null,
			emailAliases: [],
		}),
		purchasesForUser: async () => [],
		chargeState: async () => null,
	},
}))

const rpc = (authorization?: string) =>
	new Request('http://localhost/api/front-desk/rpc', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(authorization ? { authorization } : {}),
		},
		body: JSON.stringify({
			_tag: 'Request',
			id: '1',
			tag: 'customerByEmail',
			payload: { email: 'test@example.invalid' },
			headers: [],
		}),
	})

async function loadRoute(key: string | undefined) {
	mocks.env.FRONT_DESK_API_KEY = key
	vi.resetModules()
	return import('./route')
}

afterEach(() => {
	vi.resetModules()
})

describe('/api/front-desk/[...path]', () => {
	it('answers 503 when FRONT_DESK_API_KEY is unset', async () => {
		const { POST } = await loadRoute(undefined)
		expect((await POST(rpc('Bearer anything'))).status).toBe(503)
	})
	it('answers an empty 401 without the key', async () => {
		const { POST } = await loadRoute('synthetic-route-key')
		const response = await POST(rpc())
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('')
	})
	it('serves the RPC with the key', async () => {
		const { POST } = await loadRoute('synthetic-route-key')
		const response = await POST(rpc('Bearer synthetic-route-key'))
		expect(response.status).toBe(200)
		const messages = (await response.json()) as Array<{
			_tag: string
			exit?: unknown
		}>
		expect(messages.find((m) => m._tag === 'Exit')?.exit).toEqual({
			_tag: 'Success',
			value: {
				id: 'test-user',
				email: 'test@example.invalid',
				name: null,
				emailAliases: [],
			},
		})
	})
})
