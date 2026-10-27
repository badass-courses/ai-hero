import { describe, expect, it, vi } from 'vitest'

import {
	DrovrResolveUnavailableError,
	deliverResolvedPurchaseEvents,
	drovrPurchaseRecordedEventsFor,
	emailLogHash,
	resolveDrovrContacts,
} from './drovr-purchase-resolve'

const config = { baseUrl: 'https://drovr.test/', apiKey: 'key' }

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status })

const source = {
	purchaseId: 'purch_1',
	productId: 'product-aicc',
	status: 'Valid',
	totalAmount: '199',
	purchasedAt: '2026-10-27T12:00:00.000Z',
}

describe('resolveDrovrContacts', () => {
	it('returns resolved, missing and conflict answers keyed by normalized email', async () => {
		const fetcher = vi.fn(async () =>
			json({
				results: [
					{ email: 'a@example.com', status: 'resolved', contactId: 'drv-1' },
					{ email: 'b@example.com', status: 'missing' },
					{ email: 'c@example.com', status: 'conflict' },
				],
			}),
		)

		const answers = await resolveDrovrContacts({
			emails: [' A@Example.com ', 'b@example.com', 'c@example.com'],
			config,
			fetcher: fetcher as unknown as typeof fetch,
		})

		expect(answers.get('a@example.com')).toEqual({
			status: 'resolved',
			contactId: 'drv-1',
		})
		expect(answers.get('b@example.com')).toEqual({ status: 'missing' })
		expect(answers.get('c@example.com')).toEqual({ status: 'conflict' })
		const [url, init] = fetcher.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://drovr.test/resolve_contacts')
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body as string)).toEqual({
			emails: ['a@example.com', 'b@example.com', 'c@example.com'],
		})
	})

	it('batches at 1000 emails per call', async () => {
		const emails = Array.from({ length: 1001 }, (_, i) => `u${i}@example.com`)
		const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
			json({
				results: (JSON.parse(init.body as string).emails as string[]).map(
					(email) => ({ email, status: 'missing' }),
				),
			}),
		)

		const answers = await resolveDrovrContacts({
			emails,
			config,
			fetcher: fetcher as unknown as typeof fetch,
		})

		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(answers.size).toBe(1001)
	})

	it.each([
		['a 503', async () => json({}, 503)],
		['a network fault', async () => Promise.reject(new Error('boom'))],
		['a malformed body', async () => json({ nope: true })],
		['an unanswered email', async () => json({ results: [] })],
	])('throws unavailable on %s', async (_label, impl) => {
		await expect(
			resolveDrovrContacts({
				emails: ['a@example.com'],
				config,
				fetcher: vi.fn(impl) as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(DrovrResolveUnavailableError)
	})
})

describe('drovrPurchaseRecordedEventsFor', () => {
	it('maps purchase.recorded onto drovr contact with the purchase-id key and no birth', () => {
		const events = drovrPurchaseRecordedEventsFor(source, 'drv-1')

		expect(events.length).toBeGreaterThan(0)
		for (const event of events) {
			expect(event.type).toBe('purchase.recorded')
			expect(event.contactId).toBe('drv-1')
			expect(event.idempotencyKey).toBe(
				'aihero:ai-hero:purchase.recorded:purchase:purch_1',
			)
			expect(event.payload).toEqual({ productId: 'product-aicc' })
		}
		expect(events.some((event) => event.tenantId === 'org-aihero')).toBe(true)
	})
})

describe('deliverResolvedPurchaseEvents', () => {
	const events = () => drovrPurchaseRecordedEventsFor(source, 'drv-1')

	it('posts only authority-tenant events', async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 202 }))

		const result = await deliverResolvedPurchaseEvents({
			events: events(),
			config: { ingestUrl: 'https://drovr.test/events', apiKey: 'key' },
			fetcher: fetcher as unknown as typeof fetch,
		})

		expect(result.accepted).toBe(
			events().filter((event) => event.tenantId === 'org-aihero').length,
		)
		expect(fetcher).toHaveBeenCalledTimes(result.accepted)
	})

	it('throws on a transient failure so the step retries', async () => {
		await expect(
			deliverResolvedPurchaseEvents({
				events: events(),
				config: { ingestUrl: 'https://drovr.test/events', apiKey: 'key' },
				fetcher: (async () =>
					new Response(null, { status: 503 })) as typeof fetch,
			}),
		).rejects.toThrow('drovr purchase delivery failed')
	})
})

describe('emailLogHash', () => {
	it('hashes without the address and ignores case and padding', () => {
		expect(emailLogHash(' A@Example.com ')).toBe(emailLogHash('a@example.com'))
		expect(emailLogHash('a@example.com')).not.toContain('example')
	})
})
