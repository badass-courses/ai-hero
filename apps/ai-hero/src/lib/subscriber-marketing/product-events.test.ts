import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import requestSchema from './__fixtures__/product-events/request-schema.json'
// JSON imports widen string literals and infer optional union keys. The live
// fixture is deliberately checked at runtime by Zod's JSON Schema reader.
const schema = z.fromJSONSchema(
	requestSchema as unknown as Parameters<typeof z.fromJSONSchema>[0],
)
import {
	deliverProductEvents,
	pageViewFact,
	productEventsEnabled,
	type ProductFact,
} from './product-events'

const config = { baseUrl: 'https://drovr.example.test', apiKey: 'test-key' }
const email = async () => ' HUMAN@example.test '
const checkout: ProductFact = {
	_tag: 'CheckoutStep',
	at: Date.now(),
	sessionId: 'cs_test',
	step: 'started',
}
const resolved = () =>
	Response.json({
		results: [{ index: 0, status: 'resolved', contactId: 'contact-test' }],
	})
const receipt = (n = 1) =>
	Response.json({
		inserted: n,
		repeats: 0,
		signals: n,
		notStored: [],
		scope: 'product-facts',
		tenantId: 'org-aihero',
	})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

describe('product event contract and delivery', () => {
	it.each([undefined, 'false', 'TRUE', '1', ' true'])(
		'fails closed for flag %s',
		(flag) => {
			expect(
				productEventsEnabled({ AIH_DROVR_PRODUCT_EVENTS_ENABLED: flag }),
			).toBe(false)
		},
	)
	it('allows exactly true except on previews', () => {
		expect(
			productEventsEnabled({ AIH_DROVR_PRODUCT_EVENTS_ENABLED: 'true' }),
		).toBe(true)
		expect(
			productEventsEnabled({
				AIH_DROVR_PRODUCT_EVENTS_ENABLED: 'true',
				VERCEL_ENV: 'preview',
			}),
		).toBe(false)
	})
	it('posts all built fact kinds against the captured live OpenAPI request schema', async () => {
		const facts: ProductFact[] = [
			pageViewFact('/cohorts/software-factories-for-real-engineers-xdy1m')!,
			pageViewFact('/for-your-team')!,
			checkout,
			{
				_tag: 'TeamIntent',
				at: Date.now(),
				intent: 'seats',
				sourceId: 'team-inquiry',
			},
			{
				_tag: 'TeamIntent',
				at: Date.now(),
				intent: 'invoice',
				sourceId: 'team-invoice',
			},
		]
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(resolved())
			.mockResolvedValueOnce(receipt(facts.length))
		expect(await deliverProductEvents({ email, facts, config, fetcher })).toBe(
			'sent',
		)
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			`${config.baseUrl}/resolve_contacts`,
		)
		const [url, init] = fetcher.mock.calls[1]!
		expect(url).toBe(`${config.baseUrl}/product-events`)
		const payload = JSON.parse(init.body)
		expect(payload).toEqual({
			events: facts.map((fact) => ({ contactId: 'contact-test', fact })),
		})
		// Fixture copied from the live /product-events OpenAPI, not a local invented schema.
		expect(schema.safeParse(payload).success).toBe(true)
		expect(
			schema.safeParse({
				events: [{ contactId: 'x', fact: { ...checkout, step: 'expired' } }],
			}).success,
		).toBe(false)
		expect(init.headers.authorization).toBe('Bearer test-key')
	})
	it('skips anonymous identities without resolve or POST', async () => {
		const fetcher = vi.fn()
		expect(
			await deliverProductEvents({
				email: async () => null,
				facts: [checkout],
				config,
				fetcher,
			}),
		).toBe('skipped')
		expect(fetcher).not.toHaveBeenCalled()
	})
	it('skips unresolved contacts', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				Response.json({ results: [{ index: 0, status: 'missing' }] }),
			)
		expect(
			await deliverProductEvents({ email, facts: [checkout], config, fetcher }),
		).toBe('skipped')
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
	it('quietly accepts product-events-off without reading its body', async () => {
		const response = Response.json(
			{ type: 'urn:drovr:problem:product-events-off', detail: 'private' },
			{ status: 403 },
		)
		const body = vi.spyOn(response, 'json')
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(resolved())
			.mockResolvedValueOnce(response)
		expect(
			await deliverProductEvents({ email, facts: [checkout], config, fetcher }),
		).toBe('off')
		expect(body).not.toHaveBeenCalled()
	})
	it('contains timeout even when a dependency ignores abort', async () => {
		vi.useFakeTimers()
		const fetcher = vi.fn(() => new Promise<Response>(() => {}))
		const pending = deliverProductEvents({
			email,
			facts: [checkout],
			config,
			fetcher,
		})
		await vi.advanceTimersByTimeAsync(2801)
		expect(await pending).toBe('timeout')
		expect(fetcher.mock.calls).toHaveLength(1)
	})
	it('contains identity and receipt-body hangs in the same budget', async () => {
		vi.useFakeTimers()
		const pending = deliverProductEvents({
			email: () => new Promise(() => {}),
			facts: [checkout],
			config,
		})
		await vi.advanceTimersByTimeAsync(2801)
		expect(await pending).toBe('timeout')
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(resolved())
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => new Promise(() => {}),
			})
		const bodyPending = deliverProductEvents({
			email,
			facts: [checkout],
			config,
			fetcher,
		})
		await vi.advanceTimersByTimeAsync(2801)
		expect(await bodyPending).toBe('timeout')
	})
	it('does not throw on network failures or rejected receipts', async () => {
		for (const response of [
			Response.json({}, { status: 503 }),
			Response.json({
				scope: 'product-facts',
				tenantId: 'org-aihero',
				notStored: [{ index: 0, reason: 'conflict' }],
			}),
		]) {
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(resolved())
				.mockResolvedValueOnce(response)
			expect(
				await deliverProductEvents({
					email,
					facts: [checkout],
					config,
					fetcher,
				}),
			).toBe('failed')
		}
		expect(
			await deliverProductEvents({
				email,
				facts: [checkout],
				config,
				fetcher: vi.fn().mockRejectedValue(new Error('private')),
			}),
		).toBe('failed')
	})
	it('deduplicates page views per resolved contact, page and hour', async () => {
		const fact = pageViewFact('/for-your-team', Date.now() + 3_600_000)!
		const fetcher = vi
			.fn()
			.mockImplementation(async (url) =>
				String(url).endsWith('/resolve_contacts') ? resolved() : receipt(),
			)
		expect(
			await deliverProductEvents({ email, facts: [fact], config, fetcher }),
		).toBe('sent')
		expect(
			await deliverProductEvents({ email, facts: [fact], config, fetcher }),
		).toBe('skipped')
		expect(
			fetcher.mock.calls.filter(([url]) =>
				String(url).endsWith('/product-events'),
			),
		).toHaveLength(1)
	})
	it('does not track unrelated routes or include query strings', () => {
		expect(pageViewFact('/articles/hello')).toBeNull()
		expect(pageViewFact('/for-your-team?email=private')).toBeNull()
	})
})
