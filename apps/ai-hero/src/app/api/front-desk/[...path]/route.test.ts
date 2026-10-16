import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: { FRONT_DESK_API_KEY: undefined as string | undefined },
	pricingFacts: vi.fn(),
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
		pricingFacts: mocks.pricingFacts,
	},
}))

const known = <A>(value: A) => ({ value, sourceRefs: ['test:fixture'] })
const pricing = (authorization?: string) =>
	new Request('http://localhost/api/front-desk/rpc', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(authorization ? { authorization } : {}),
		},
		body: JSON.stringify({
			_tag: 'Request',
			id: '1',
			tag: 'pricingFacts',
			payload: {
				email: 'buyer@example.test',
				productId: 'product-s00zs',
				quantity: 3,
				orderKind: 'team',
			},
			headers: [],
		}),
	})

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
	it('gates pricingFacts behind the key without reading facts', async () => {
		const { POST, GET } = await loadRoute('synthetic-route-key')
		for (const auth of [undefined, 'Bearer wrong']) {
			const response = await POST(pricing(auth))
			expect(response.status).toBe(401)
			expect(await response.text()).toBe('')
		}
		expect((await GET(pricing())).status).toBe(401)
		expect(mocks.pricingFacts).not.toHaveBeenCalled()
		const unconfigured = await loadRoute(undefined)
		expect((await unconfigured.POST(pricing('Bearer x'))).status).toBe(503)
		expect(mocks.pricingFacts).not.toHaveBeenCalled()
	})
	it('serves pricingFacts with the key', async () => {
		const facts = {
			product: {
				appProductId: 'product-s00zs',
				merchantPriceId: 'price-test',
				merchantUnit: 100000,
				sourceRefs: ['test:price'],
			},
			buyer: { userId: null, sourceRefs: ['test:user'] },
			quantity: 3,
			facts: {
				alumni: known('none'),
				credit: known(null),
				creditUse: known('available'),
				existingSeats: known(0),
				legend: { gap: 'FactsUnavailable' },
				order: known('team'),
				ppp: { gap: 'FactsUnavailable' },
			},
		}
		mocks.pricingFacts.mockResolvedValue(facts)
		const { POST } = await loadRoute('synthetic-route-key')
		const response = await POST(pricing('Bearer synthetic-route-key'))
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const messages = (await response.json()) as Array<{
			_tag: string
			exit?: { _tag: string; value: unknown }
		}>
		const exit = messages.find((m) => m._tag === 'Exit')?.exit
		expect(exit?._tag).toBe('Success')
		expect(exit?.value).toEqual(facts)
		expect(mocks.pricingFacts).toHaveBeenCalledWith({
			email: 'buyer@example.test',
			productId: 'product-s00zs',
			quantity: 3,
			orderKind: 'team',
		})
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
