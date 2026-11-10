import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDrovrListState } from './drovr-list-state'

const evidence = {
	contactId: 'contact-1',
	kitSubscriberId: '42',
	tenantId: 'org-aihero',
	scope: 'all',
	state: 'confirmed',
	forms: [{ formId: 'newsletter', state: 'confirmed' }],
	stops: [],
	unknownReason: null,
}
const config = (body: unknown, status = 200) => ({
	baseUrl: 'https://drovr.example.test/',
	apiKey: 'synthetic-key',
	fetch: vi.fn(async () =>
		Response.json(body, { status }),
	) as unknown as typeof fetch,
})

describe('contact-list-state REST client', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('uses GET, exactly one Kit alias query and the tenant bearer, without an MCP envelope', async () => {
		const c = config(evidence)
		expect(await readDrovrListState({ kitSubscriberId: '42' }, c)).toEqual(
			evidence,
		)
		expect(c.fetch).toHaveBeenCalledWith(
			'https://drovr.example.test/contact-list-state?kitSubscriberId=42',
			{
				method: 'GET',
				cache: 'no-store',
				headers: {
					authorization: 'Bearer synthetic-key',
					accept: 'application/json',
				},
				signal: expect.any(AbortSignal),
			},
		)
	})

	it('pins the desk-recorded synthetic 200 response and exact contact request shape', async () => {
		// Synthetic, no-customer-data response from the desk probe. A fake that
		// asserts the wire request would reject the former POST /mcp bug.
		const recorded = {
			contactId: 'desk-probe-nonexistent',
			forms: [],
			kitSubscriberId: null,
			scope: 'all',
			state: 'unknown',
			stops: [],
			tenantId: 'org-aihero',
			unknownReason: 'no-consent-evidence',
		}
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input))
				expect(url.pathname).toBe('/contact-list-state')
				expect([...url.searchParams.entries()]).toEqual([
					['contactId', 'desk-probe-nonexistent'],
				])
				expect(init?.method).toBe('GET')
				expect(init?.body).toBeUndefined()
				expect(init?.headers).toEqual({
					authorization: 'Bearer synthetic-key',
					accept: 'application/json',
				})
				return Response.json(recorded)
			},
		)
		expect(
			await readDrovrListState(
				{ contactId: recorded.contactId },
				{
					baseUrl: 'https://drovr.example.test',
					apiKey: 'synthetic-key',
					fetch: fetcher,
				},
			),
		).toEqual(recorded)
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it.each([
		['wrong contact', { ...evidence, contactId: 'other' }, 200],
		['wrong tenant', { ...evidence, tenantId: 'other' }, 200],
		['missing positive state', { ...evidence, state: undefined }, 200],
		[
			'old MCP envelope',
			{
				jsonrpc: '2.0',
				id: 'aih-list-state',
				result: { structuredContent: evidence },
			},
			200,
		],
		['malformed request', { type: 'contact-list-state-malformed' }, 400],
		['forbidden', { type: 'contact-list-state-alias-forbidden' }, 403],
		['unavailable', { type: 'contact-list-state-unavailable' }, 503],
	] as const)('%s answers unknown', async (_name, body, status) => {
		expect(
			await readDrovrListState(
				{ contactId: 'contact-1' },
				config(body, status),
			),
		).toBeNull()
	})

	it('a mismatched Kit alias answers unknown', async () => {
		expect(
			await readDrovrListState({ kitSubscriberId: '99' }, config(evidence)),
		).toBeNull()
	})

	it('encodes a contact id as one query value', async () => {
		const id = 'synthetic&kitSubscriberId=99'
		const c = config({ ...evidence, contactId: id })
		expect(await readDrovrListState({ contactId: id }, c)).not.toBeNull()
		expect(c.fetch).toHaveBeenCalledWith(
			`https://drovr.example.test/contact-list-state?contactId=${encodeURIComponent(id)}`,
			expect.anything(),
		)
	})

	it.each([
		{},
		{ contactId: '' },
		{ contactId: 'contact-1', kitSubscriberId: '42' },
	])('refuses invalid identity input before fetching: %j', async (identity) => {
		const c = config(evidence)
		expect(
			await readDrovrListState(identity as { contactId: string }, c),
		).toBeNull()
		expect(c.fetch).not.toHaveBeenCalled()
	})

	it('no configuration answers unknown without a network call', async () => {
		expect(
			await readDrovrListState({ contactId: 'contact-1' }, undefined),
		).toBeNull()
	})

	it('bounds the entire read even when fetch ignores abort', async () => {
		vi.useFakeTimers()
		const fetcher = vi.fn(
			(_url: RequestInfo | URL, _init?: RequestInit) =>
				new Promise<Response>(() => {}),
		)
		const read = readDrovrListState(
			{ contactId: 'contact-1' },
			{
				baseUrl: 'https://drovr.example.test',
				apiKey: 'synthetic-key',
				fetch: fetcher,
			},
		)
		await vi.advanceTimersByTimeAsync(1500)
		expect(await read).toBeNull()
		expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
	})
})
