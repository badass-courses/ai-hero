import { describe, expect, it, vi } from 'vitest'

import {
	BINDING_QUOTES_PATH,
	createFrontDeskData,
	POLICY_FRESH_MS,
	POLICY_MAX_STALE_MS,
	QUOTES_FRESH_MS,
} from './front-desk-data'
import {
	SYNTHETIC_POLICY_PRODUCT,
	SYNTHETIC_POLICY_VERSION,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

const C5 = 'product-s00zs'
const ETAG = `"${SYNTHETIC_POLICY_VERSION}"`
const policyBody = () => ({
	policy: syntheticPolicy(),
	version: SYNTHETIC_POLICY_VERSION,
})
const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', etag: ETAG },
		...init,
	})

const quote = {
	amount: 50_000,
	basis: 'Unit',
	currency: 'USD',
	expiresAt: null,
	product: SYNTHETIC_POLICY_PRODUCT,
	quantity: 1,
	ref: 'quote-synthetic@1#line-1',
}

function setup(fetchImpl: (url: URL, init: RequestInit) => Promise<Response>) {
	let clock = 1_000_000
	const fetch = vi.fn(fetchImpl)
	const data = createFrontDeskData({
		url: 'https://desk.test',
		pricingToken: 'pricing-token',
		quotesToken: 'quotes-token',
		fetch: fetch as unknown as typeof globalThis.fetch,
		now: () => clock,
	})
	return {
		data,
		fetch,
		advance: (ms: number) => {
			clock += ms
		},
	}
}

describe('front-desk policy reads', () => {
	it('asks for one product with the pricing token and decodes the policy', async () => {
		const { data, fetch } = setup(async () => json(policyBody()))
		const read = await data.policy(C5)
		expect(read).toEqual({
			ok: true,
			value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
		})
		const [url, init] = fetch.mock.calls[0]!
		expect(url.toString()).toBe(
			`https://desk.test/api/pricing/policy?productId=${C5}`,
		)
		expect(init.headers).toEqual({ authorization: 'Bearer pricing-token' })
	})

	it('serves a fresh policy from cache, then revalidates a stale one with its ETag', async () => {
		const { data, fetch, advance } = setup(async (_, init) =>
			(init.headers as Record<string, string>)['if-none-match'] === ETAG
				? new Response(null, { status: 304 })
				: json(policyBody()),
		)
		await data.policy(C5)
		advance(POLICY_FRESH_MS - 1)
		await data.policy(C5)
		expect(fetch).toHaveBeenCalledTimes(1)

		advance(2)
		// Stale: served at once while one background revalidation runs.
		await expect(data.policy(C5)).resolves.toMatchObject({ ok: true })
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
		expect(
			(fetch.mock.calls[1]![1].headers as Record<string, string>)['if-none-match'],
		).toBe(ETAG)
	})

	it('keeps serving a stale policy through an outage, but not past its stale limit', async () => {
		let up = true
		const { data, advance } = setup(async () => {
			if (!up) throw new Error('down')
			return json(policyBody())
		})
		await data.policy(C5)
		up = false
		advance(POLICY_FRESH_MS + 1)
		await expect(data.policy(C5)).resolves.toMatchObject({ ok: true })
		advance(POLICY_MAX_STALE_MS)
		await expect(data.policy(C5)).resolves.toEqual({
			ok: false,
			reason: 'policy-unreachable',
		})
	})

	it.each([
		['a non-200', () => new Response('no', { status: 401 }), 'policy-http-401'],
		['an undecodable policy', () => json({ policy: { list: 'x' }, version: 'v' }), 'policy-malformed'],
		[
			'a version that is not the policy\'s own',
			() => json({ ...policyBody(), version: 'other' }),
			'policy-version-mismatch',
		],
	])('fails closed on %s', async (_, respond, reason) => {
		const { data } = setup(async () => respond())
		await expect(data.policy(C5)).resolves.toEqual({ ok: false, reason })
	})
})

describe('front-desk binding quote reads', () => {
	const input = {
		email: ' Buyer@Example.test ',
		productId: C5,
		quantity: 1,
	}

	it('posts the normalized buyer with the quotes token', async () => {
		const { data, fetch } = setup(async () => json([quote]))
		await expect(
			data.bindingQuotes({ ...input, fresh: true }),
		).resolves.toEqual({ ok: true, value: [quote] })
		const [url, init] = fetch.mock.calls[0]!
		expect(url.toString()).toBe(`https://desk.test${BINDING_QUOTES_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers).toMatchObject({ authorization: 'Bearer quotes-token' })
		expect(JSON.parse(init.body as string)).toEqual({
			email: 'buyer@example.test',
			productId: C5,
			quantity: 1,
		})
	})

	it('lets display reuse a recent answer but always reads fresh at checkout', async () => {
		const { data, fetch, advance } = setup(async () => json([quote]))
		await data.bindingQuotes({ ...input, fresh: false })
		advance(QUOTES_FRESH_MS - 1)
		await data.bindingQuotes({ ...input, fresh: false })
		expect(fetch).toHaveBeenCalledTimes(1)
		await data.bindingQuotes({ ...input, fresh: true })
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it('reports a failed fresh read as an error, never an empty list', async () => {
		let up = true
		const { data } = setup(async () => {
			if (!up) return new Response('busy', { status: 503 })
			return json([quote])
		})
		await data.bindingQuotes({ ...input, fresh: false })
		up = false
		await expect(data.bindingQuotes({ ...input, fresh: true })).resolves.toEqual({
			ok: false,
			reason: 'quotes-http-503',
		})
	})

	it('fails without a quotes token rather than answering no quotes', async () => {
		const data = createFrontDeskData({
			url: 'https://desk.test',
			pricingToken: 'pricing-token',
			fetch: vi.fn() as unknown as typeof fetch,
		})
		await expect(data.bindingQuotes({ ...input, fresh: true })).resolves.toEqual({
			ok: false,
			reason: 'quotes-not-configured',
		})
	})
})
