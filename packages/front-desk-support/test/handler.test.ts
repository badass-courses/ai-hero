import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFrontDeskHandler, type FrontDeskHooks } from '../src/index.js'

const key = 'synthetic-test-key'
const customer = {
	id: 'test-user',
	name: 'Test User',
	email: 'test@example.invalid',
	emailAliases: [],
}
const purchase = {
	id: 'test-purchase',
	productId: 'test-product',
	productName: 'Test Product',
	amount: 19900,
	currency: 'usd',
	status: 'valid',
	createdAt: '2026-01-01T00:00:00.000Z',
	seats: 2,
	merchantChargeId: 'merchant-test',
	stripeChargeId: 'ch_test',
}
const charge = {
	stripeChargeId: 'ch_test',
	amount: 19900,
	currency: 'usd',
	amountRefunded: 1000,
	refundCount: 1,
	disputed: false,
	disputeStatus: null,
	presentmentAmount: 19900,
	presentmentCurrency: 'usd',
}
const hooks: FrontDeskHooks = {
	customerByEmail: async () => customer,
	purchasesForUser: async () => [purchase],
	chargeState: async () => charge,
	pricingFacts: async () => null,
}
function request(
	tag = 'customerByEmail',
	payload: unknown = { email: customer.email },
	auth: string | null = `Bearer ${key}`,
) {
	return new Request('http://localhost/api/front-desk/rpc', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(auth ? { authorization: auth } : {}),
		},
		body: JSON.stringify({
			_tag: 'Request',
			id: '1',
			tag,
			payload,
			headers: [],
		}),
	})
}
async function rpc(h: FrontDeskHooks, tag: string, payload: unknown) {
	const response = await createFrontDeskHandler(h, { apiKey: key }).POST(
		request(tag, payload),
	)
	assert.equal(response.status, 200)
	const messages = (await response.json()) as any[]
	return messages.find((m) => m._tag === 'Exit').exit
}
test('real RPC round trip for all three read hooks', async () => {
	for (const [tag, payload, expected] of [
		['customerByEmail', { email: customer.email }, customer],
		['purchasesForUser', { userId: customer.id }, [purchase]],
		['chargeState', { stripeChargeId: 'ch_test' }, charge],
	] as const) {
		assert.deepEqual(await rpc(hooks, tag, payload), {
			_tag: 'Success',
			value: expected,
		})
	}
})
test('nullable reads round trip', async () => {
	assert.deepEqual(
		await rpc(
			{ ...hooks, customerByEmail: async () => null },
			'customerByEmail',
			{ email: customer.email },
		),
		{ _tag: 'Success', value: null },
	)
})
test('missing and invalid keys return empty 401 before invoking hooks', async () => {
	let calls = 0
	const handler = createFrontDeskHandler(
		{
			...hooks,
			customerByEmail: async () => {
				calls++
				return customer
			},
		},
		{ apiKey: key },
	)
	for (const auth of [null, 'Bearer wrong', 'Basic wrong', `Bearer ${key}x`]) {
		for (const method of ['GET', 'POST'] as const) {
			const response = await handler[method](
				request('customerByEmail', {}, auth),
			)
			assert.equal(response.status, 401)
			assert.equal(await response.text(), '')
		}
	}
	assert.equal(calls, 0)
})
test('unconfigured returns 503', async () => {
	for (const apiKey of [undefined, '']) {
		const handler = createFrontDeskHandler(hooks, { apiKey })
		assert.equal((await handler.POST(request())).status, 503)
		assert.equal((await handler.GET(request())).status, 503)
	}
})
test('malformed hook result fails decoding and never reflects data', async () => {
	const exit = await rpc(
		{
			...hooks,
			customerByEmail: async () =>
				({ ...customer, id: 123, name: 'PRIVATE_SENTINEL' }) as any,
		},
		'customerByEmail',
		{ email: customer.email },
	)
	assert.equal(exit._tag, 'Failure')
	assert.match(JSON.stringify(exit), /INVALID_HOOK_RESULT/)
	assert.doesNotMatch(JSON.stringify(exit), /PRIVATE_SENTINEL|123/)
})
test('hook failures carry codes, not exception messages', async () => {
	const exit = await rpc(
		{
			...hooks,
			chargeState: async () => {
				throw new Error('PRIVATE_SENTINEL')
			},
		},
		'chargeState',
		{ stripeChargeId: 'ch_test' },
	)
	assert.equal(exit._tag, 'Failure')
	assert.match(JSON.stringify(exit), /HOOK_FAILED/)
	assert.doesNotMatch(JSON.stringify(exit), /PRIVATE_SENTINEL/)
})
test('payload decode failure does not reflect customer data', async () => {
	const response = await createFrontDeskHandler(hooks, { apiKey: key }).POST(
		request('customerByEmail', { email: { private: 'PRIVATE_SENTINEL' } }),
	)
	assert.doesNotMatch(await response.text(), /PRIVATE_SENTINEL/)
})
test('authenticated GET cannot invoke a read hook', async () => {
	const response = await createFrontDeskHandler(hooks, { apiKey: key }).GET(
		request(),
	)
	assert.equal(response.status, 405)
})
