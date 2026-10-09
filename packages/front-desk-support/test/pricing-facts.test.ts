import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
	createFrontDeskHandler,
	type FrontDeskHooks,
	type PricingFacts,
} from '../src/index.js'

// front-desk decodes this same fixture with its own BuyerFacts schema, so the
// two sides check one shared shape without sharing source.
const fixture: PricingFacts = JSON.parse(
	await readFile(
		new URL('./fixtures/pricing-facts.json', import.meta.url),
		'utf8',
	),
)
const key = 'synthetic-test-key'
const ask = {
	email: 'buyer@example.test',
	productId: 'product-test',
	quantity: 1,
	orderKind: 'individual',
} as const
const hooks = (
	pricingFacts: FrontDeskHooks['pricingFacts'],
): FrontDeskHooks => ({
	customerByEmail: async () => null,
	purchasesForUser: async () => [],
	chargeState: async () => null,
	pricingFacts,
})
function request(payload: unknown, auth: string | null = `Bearer ${key}`) {
	return new Request('http://localhost/api/front-desk/rpc', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(auth ? { authorization: auth } : {}),
		},
		body: JSON.stringify({
			_tag: 'Request',
			id: '1',
			tag: 'pricingFacts',
			payload,
			headers: [],
		}),
	})
}
async function exit(
	pricingFacts: FrontDeskHooks['pricingFacts'],
	payload: unknown = ask,
) {
	const response = await createFrontDeskHandler(hooks(pricingFacts), {
		apiKey: key,
	}).POST(request(payload))
	assert.equal(response.status, 200)
	const messages = (await response.json()) as any[]
	return messages.find((m) => m._tag === 'Exit').exit
}
const failureCode = (result: any) => result.cause[0].error.code
const withFacts = (facts: Record<string, unknown>) => ({
	...fixture,
	facts: { ...fixture.facts, ...facts },
})

test('the shared fixture decodes as PricingFacts and comes back unchanged', async () => {
	const seen: unknown[] = []
	const result = await exit(async (request) => {
		seen.push(request)
		return fixture
	})
	assert.equal(result._tag, 'Success')
	assert.deepEqual(result.value, fixture)
	assert.deepEqual(seen, [ask])
	assert.deepEqual(Object.keys(fixture.facts).sort(), [
		'alumni',
		'credit',
		'creditUse',
		'existingSeats',
		'legend',
		'order',
		'ppp',
	])
})

test('every fact is either known with sourceRefs or a typed gap', async () => {
	for (const fact of [
		{ value: 'none', sourceRefs: ['test:a'] },
		{ gap: 'FactsUnavailable' },
		{ gap: 'IdentityUnverified' },
		{ gap: 'PaymentAmbiguous' },
	]) {
		const result = await exit(async () => withFacts({ alumni: fact }) as any)
		assert.equal(result._tag, 'Success')
		assert.deepEqual(result.value.facts.alumni, fact)
	}
})

test('rejects facts outside the structural BuyerFacts shape', async () => {
	for (const facts of [
		{ alumni: { value: 'c9', sourceRefs: ['test:a'] } },
		{ alumni: { value: 'none' } },
		{ credit: { value: { paid: -1, source: 'p' }, sourceRefs: ['test:a'] } },
		{ creditUse: { gap: 'Unknown' } },
		{ existingSeats: { value: 1.5, sourceRefs: ['test:a'] } },
		{ ppp: { value: { accepted: true, percent: 101 }, sourceRefs: ['t'] } },
		{ legend: undefined },
	]) {
		const result = await exit(async () => withFacts(facts) as any)
		assert.equal(
			failureCode(result),
			'INVALID_HOOK_RESULT',
			JSON.stringify(facts),
		)
		assert.doesNotMatch(JSON.stringify(result), /c9|101|Unknown/)
	}
})

test('drops anything the hook adds beyond the shape', async () => {
	const result = await exit(
		async () =>
			({
				...fixture,
				extra: 'not-part-of-the-shape',
				product: { ...fixture.product, list: 1 },
			}) as any,
	)
	assert.equal(result._tag, 'Success')
	assert.deepEqual(result.value, fixture)
})

test('rejects facts for a different product, quantity or order kind', async () => {
	for (const mismatch of [
		{ ...fixture, product: { ...fixture.product, appProductId: 'product-x' } },
		{ ...fixture, quantity: 2 },
		withFacts({ order: { value: 'team', sourceRefs: ['request:orderKind'] } }),
	]) {
		const result = await exit(async () => mismatch as PricingFacts)
		assert.equal(failureCode(result), 'INVALID_HOOK_RESULT')
	}
})

test('a product the app reports no facts for is PRODUCT_NOT_SUPPORTED', async () => {
	const result = await exit(async () => null)
	assert.equal(failureCode(result), 'PRODUCT_NOT_SUPPORTED')
})

test('a throwing hook is HOOK_FAILED with no detail', async () => {
	const result = await exit(async () => {
		throw new Error('db down for buyer@example.test')
	})
	assert.equal(failureCode(result), 'HOOK_FAILED')
	assert.doesNotMatch(JSON.stringify(result), /example\.test|db down/)
})

test('invalid requests never reach the hook', async () => {
	let calls = 0
	for (const payload of [
		{ ...ask, email: '' },
		{ ...ask, quantity: 0 },
		{ ...ask, quantity: 1.5 },
		{ ...ask, orderKind: 'gift' },
		{ email: ask.email },
	]) {
		const result = await exit(async () => {
			calls++
			return fixture
		}, payload)
		assert.equal(result._tag, 'Failure')
	}
	assert.equal(calls, 0)
})

test('pricingFacts sits behind the same key gate', async () => {
	let calls = 0
	const handler = createFrontDeskHandler(
		hooks(async () => {
			calls++
			return fixture
		}),
		{ apiKey: key },
	)
	for (const auth of [null, 'Bearer wrong', key]) {
		const response = await handler.POST(request(ask, auth))
		assert.equal(response.status, 401)
		assert.equal(await response.text(), '')
	}
	const unset = createFrontDeskHandler(
		hooks(async () => fixture),
		{},
	)
	assert.equal((await unset.POST(request(ask))).status, 503)
	assert.equal(calls, 0)
})
