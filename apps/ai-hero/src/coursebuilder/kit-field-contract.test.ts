import { describe, expect, it } from 'vitest'

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

import {
	createKitCustomFieldCache,
	KIT_CUSTOM_FIELD_CACHE_TTL_MS,
	KitFieldsUnconfirmedError,
	subscribeWithKitFields,
} from './kit-field-contract'

/**
 * A fake Kit v3: custom fields, one subscriber, and a call log with the
 * method and path (no query) of every request.
 */
function fakeKit(
	options: {
		fields?: string[]
		subscriberFields?: Record<string, string | null>
		putStatus?: number[]
		subscribeStatus?: number
		dropFromReadback?: string[]
		/** Fields Kit accepts but never stores, however often they are written. */
		neverKeep?: string[]
	} = {},
) {
	const fields = new Set(options.fields ?? [])
	const stored: Record<string, string | null> = {
		...Object.fromEntries([...fields].map((key) => [key, null])),
		...(options.subscriberFields ?? {}),
	}
	const putStatus = [...(options.putStatus ?? [])]
	const dropFromReadback = new Set(options.dropFromReadback ?? [])
	const neverKeep = new Set(options.neverKeep ?? [])
	const calls: string[] = []
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/\/\d+/g, '/:id')
		calls.push(`${method} ${path}`)
		const body = init?.body ? JSON.parse(String(init.body)) : {}
		if (method === 'GET' && path === '/v3/custom_fields') {
			return json(200, {
				custom_fields: [...fields].map((key, index) => ({
					id: index + 1,
					key,
					label: key,
					name: `ck_field_${index + 1}_${key}`,
				})),
			})
		}
		if (method === 'POST' && path === '/v3/custom_fields') {
			fields.add(body.label)
			stored[body.label] ??= null
			return json(200, { id: 99, key: body.label, label: body.label })
		}
		if (
			method === 'POST' &&
			/\/v3\/(forms|sequences|tags)\/:id\/subscribe/.test(path)
		) {
			if (options.subscribeStatus)
				return json(options.subscribeStatus, { error: 'nope' })
			for (const [key, value] of Object.entries(body.fields ?? {})) {
				if (fields.has(key)) stored[key] = String(value)
			}
			return json(200, {
				subscription: { subscriber: { id: 4242 } },
			})
		}
		if (method === 'PUT' && path === '/v3/subscribers/:id') {
			const status = putStatus.shift() ?? 200
			if (status !== 200) return json(status, { error: 'Unknown field' })
			for (const [key, value] of Object.entries(body.fields ?? {})) {
				if (fields.has(key)) stored[key] = String(value)
			}
			return json(200, { subscriber: { id: 4242 } })
		}
		if (method === 'GET' && path === '/v3/subscribers/:id') {
			const readback = Object.fromEntries(
				Object.entries(stored).filter(
					([key]) => !dropFromReadback.has(key) && !neverKeep.has(key),
				),
			)
			dropFromReadback.clear()
			return json(200, {
				subscriber: {
					id: 4242,
					email_address: 'reader@example.com',
					state: 'active',
					fields: readback,
				},
			})
		}
		if (method === 'GET' && path === '/v3/subscribers/:id/tags') {
			return json(200, { tags: [{ id: 7 }] })
		}
		return json(404, { error: `unexpected ${method} ${path}` })
	}) as typeof globalThis.fetch
	return { fetch, calls, fields, stored }
}

const options = (fields?: Record<string, string>) => ({
	listId: '2757199',
	listType: 'sequence' as const,
	user: { email: 'reader@example.com', name: 'Reader' },
	...(fields ? { fields } : {}),
})

const deps = (
	kit: ReturnType<typeof fakeKit>,
	cache = createKitCustomFieldCache(),
) => ({
	apiKey: 'key',
	apiSecret: 'secret',
	fetch: kit.fetch,
	cache,
})

describe('Kit field contract with a custom-field cache', () => {
	it('lists custom fields once, creates only the missing ones, then subscribes, writes, and reads back', async () => {
		const kit = fakeKit({ fields: ['aih_known'] })
		const result = await subscribeWithKitFields(
			options({ aih_known: 'a', aih_new: 'b' }),
			deps(kit),
		)
		expect(kit.calls).toEqual([
			'GET /v3/custom_fields',
			'POST /v3/custom_fields',
			'POST /v3/sequences/:id/subscribe',
			'PUT /v3/subscribers/:id',
			'GET /v3/subscribers/:id',
			'GET /v3/subscribers/:id/tags',
		])
		expect(result).toMatchObject({
			id: 4242,
			email_address: 'reader@example.com',
			fields: { aih_known: 'a', aih_new: 'b' },
			// Course Builder's shape: the whole /tags response, not the array.
			tags: { tags: [{ id: 7 }] },
		})
	})

	it('makes four Kit calls when the cache already knows every field', async () => {
		const kit = fakeKit({ fields: ['aih_known', 'aih_other'] })
		const cache = createKitCustomFieldCache()
		await subscribeWithKitFields(options({ aih_known: 'a' }), deps(kit, cache))
		kit.calls.length = 0
		await subscribeWithKitFields(
			options({ aih_known: 'b', aih_other: 'c' }),
			deps(kit, cache),
		)
		expect(kit.calls).toEqual([
			'POST /v3/sequences/:id/subscribe',
			'PUT /v3/subscribers/:id',
			'GET /v3/subscribers/:id',
			'GET /v3/subscribers/:id/tags',
		])
	})

	it('lists again once the cache is older than its TTL', async () => {
		let now = 1_000_000
		const cache = createKitCustomFieldCache({ now: () => now })
		const kit = fakeKit({ fields: ['aih_known'] })
		await subscribeWithKitFields(options({ aih_known: 'a' }), deps(kit, cache))
		now += KIT_CUSTOM_FIELD_CACHE_TTL_MS + 1
		kit.calls.length = 0
		await subscribeWithKitFields(options({ aih_known: 'b' }), deps(kit, cache))
		expect(kit.calls[0]).toBe('GET /v3/custom_fields')
		expect(kit.calls).toHaveLength(5)
	})

	it('re-lists before creating a field the cache has not seen, and never creates one that exists', async () => {
		const kit = fakeKit({ fields: ['aih_known'] })
		const cache = createKitCustomFieldCache()
		await subscribeWithKitFields(options({ aih_known: 'a' }), deps(kit, cache))
		kit.fields.add('aih_added_elsewhere')
		kit.calls.length = 0
		await subscribeWithKitFields(
			options({ aih_known: 'a', aih_added_elsewhere: 'x' }),
			deps(kit, cache),
		)
		expect(kit.calls.slice(0, 2)).toEqual([
			'GET /v3/custom_fields',
			'POST /v3/sequences/:id/subscribe',
		])
	})

	it('invalidates and retries once when Kit refuses the field write with a 4xx', async () => {
		const kit = fakeKit({ fields: ['aih_known'], putStatus: [422] })
		const cache = createKitCustomFieldCache()
		const result = await subscribeWithKitFields(
			options({ aih_known: 'a' }),
			deps(kit, cache),
		)
		expect(kit.calls).toEqual([
			'GET /v3/custom_fields',
			'POST /v3/sequences/:id/subscribe',
			'PUT /v3/subscribers/:id',
			'GET /v3/custom_fields',
			'PUT /v3/subscribers/:id',
			'GET /v3/subscribers/:id',
			'GET /v3/subscribers/:id/tags',
		])
		expect(result).toMatchObject({ fields: { aih_known: 'a' } })
	})

	it('invalidates and writes again once when the readback is missing a requested field', async () => {
		// The cache believes the field exists; Kit deleted it since.
		const kit = fakeKit({ fields: ['aih_known', 'aih_deleted'] })
		const cache = createKitCustomFieldCache()
		await subscribeWithKitFields(
			options({ aih_known: 'a', aih_deleted: 'x' }),
			deps(kit, cache),
		)
		kit.fields.delete('aih_deleted')
		delete kit.stored.aih_deleted
		kit.calls.length = 0
		const result = await subscribeWithKitFields(
			options({ aih_known: 'b', aih_deleted: 'y' }),
			deps(kit, cache),
		)
		expect(kit.calls).toEqual([
			'POST /v3/sequences/:id/subscribe',
			'PUT /v3/subscribers/:id',
			'GET /v3/subscribers/:id',
			'GET /v3/subscribers/:id/tags',
			'GET /v3/custom_fields',
			'POST /v3/custom_fields',
			'PUT /v3/subscribers/:id',
			'GET /v3/subscribers/:id',
			'GET /v3/subscribers/:id/tags',
		])
		expect(result).toMatchObject({
			fields: { aih_known: 'b', aih_deleted: 'y' },
		})
	})

	it('fails the contract when the recheck still cannot confirm a field', async () => {
		const kit = fakeKit({
			fields: ['aih_known', 'aih_lost'],
			neverKeep: ['aih_lost'],
		})
		const error = await subscribeWithKitFields(
			options({ aih_known: 'a', aih_lost: 'x' }),
			deps(kit),
		).catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(KitFieldsUnconfirmedError)
		expect(error).toMatchObject({ missing: ['aih_lost'] })
		// One recheck, then it stops: no loop.
		expect(
			kit.calls.filter((call) => call === 'PUT /v3/subscribers/:id'),
		).toHaveLength(2)
	})

	it('fails the contract when the write was refused and the retry still cannot confirm a field', async () => {
		const kit = fakeKit({
			fields: ['aih_known', 'aih_lost'],
			putStatus: [422],
			neverKeep: ['aih_lost'],
		})
		await expect(
			subscribeWithKitFields(
				options({ aih_known: 'a', aih_lost: 'x' }),
				deps(kit),
			),
		).rejects.toMatchObject({
			name: 'KitFieldsUnconfirmedError',
			missing: ['aih_lost'],
		})
	})

	it('skips the field list and the write when there are no fields', async () => {
		const kit = fakeKit()
		await subscribeWithKitFields(options(), deps(kit))
		expect(kit.calls).toEqual([
			'POST /v3/sequences/:id/subscribe',
			'GET /v3/subscribers/:id',
			'GET /v3/subscribers/:id/tags',
		])
	})

	it('surfaces a Kit refusal as ConvertKitApiError with its status', async () => {
		const kit = fakeKit({ fields: ['aih_known'], subscribeStatus: 429 })
		await expect(
			subscribeWithKitFields(options({ aih_known: 'a' }), deps(kit)),
		).rejects.toEqual(expect.objectContaining({ status: 429 }))
		await expect(
			subscribeWithKitFields(options({ aih_known: 'a' }), deps(kit)),
		).rejects.toBeInstanceOf(ConvertKitApiError)
	})

	it('refuses a missing list id before any Kit call, exactly as Course Builder did', async () => {
		// Course Builder's subscribeToList threw 'No listId provided' too: its
		// provider object carries no defaultListId, so the server route's
		// `listId || provider.defaultListId` was already undefined.
		const kit = fakeKit({ fields: ['aih_known'] })
		await expect(
			subscribeWithKitFields(
				{ ...options({ aih_known: 'a' }), listId: undefined },
				deps(kit),
			),
		).rejects.toThrow('No listId provided')
		expect(kit.calls).toEqual([])
	})

	it('subscribes forms and tags on their own endpoints', async () => {
		const kit = fakeKit()
		await subscribeWithKitFields(
			{ ...options(), listType: 'form', listId: '9376133' },
			deps(kit),
		)
		await subscribeWithKitFields(
			{ ...options(), listType: 'tag', listId: '1' },
			deps(kit),
		)
		expect(kit.calls.filter((call) => call.endsWith('/subscribe'))).toEqual([
			'POST /v3/forms/:id/subscribe',
			'POST /v3/tags/:id/subscribe',
		])
	})
})
