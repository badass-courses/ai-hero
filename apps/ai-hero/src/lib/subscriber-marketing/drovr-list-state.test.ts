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
const wrap = (structuredContent: unknown) => ({
	jsonrpc: '2.0',
	id: 'aih-list-state',
	result: { structuredContent },
})
const config = (body: unknown, status = 200) => ({
	baseUrl: 'https://drovr.example.test/',
	apiKey: 'synthetic-key',
	fetch: vi.fn(async () =>
		Response.json(body, { status }),
	) as unknown as typeof fetch,
})

describe('get_contact_list_state MCP client', () => {
	afterEach(() => {
		vi.useRealTimers()
	})
	it('uses the existing capability with the tenant bearer and exact identity', async () => {
		const c = config(wrap(evidence))
		expect(await readDrovrListState({ kitSubscriberId: '42' }, c)).toEqual(
			evidence,
		)
		expect(c.fetch).toHaveBeenCalledWith(
			'https://drovr.example.test/mcp',
			expect.objectContaining({
				method: 'POST',
				cache: 'no-store',
				headers: expect.objectContaining({
					authorization: 'Bearer synthetic-key',
				}),
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'aih-list-state',
					method: 'tools/call',
					params: {
						name: 'get_contact_list_state',
						arguments: { kitSubscriberId: '42' },
					},
				}),
			}),
		)
	})
	it.each([
		['wrong contact', wrap({ ...evidence, contactId: 'other' }), 200],
		['wrong tenant', wrap({ ...evidence, tenantId: 'other' }), 200],
		['missing positive state', wrap({ ...evidence, state: undefined }), 200],
		[
			'RPC error',
			{
				jsonrpc: '2.0',
				id: 'aih-list-state',
				error: { code: -1, message: 'refused' },
			},
			200,
		],
		[
			'tool refusal',
			{
				...wrap(evidence),
				result: { structuredContent: evidence, isError: true },
			},
			200,
		],
		['forbidden', wrap(evidence), 403],
		['unavailable', wrap(evidence), 503],
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
			await readDrovrListState(
				{ kitSubscriberId: '99' },
				config(wrap(evidence)),
			),
		).toBeNull()
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
