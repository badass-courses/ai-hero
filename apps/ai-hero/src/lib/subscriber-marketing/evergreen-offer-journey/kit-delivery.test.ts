import { Effect, Either } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EVERGREEN_OFFER_JOURNEY_V1 } from './definition'
import type { SendMessageIntent } from './domain'
import { createKitDeliveryPort } from './kit-delivery'
import {
	parseContactId,
	parseIntentKey,
	parseIsoInstant,
	parseJourneyId,
	type ParseResult,
} from './primitives'

function must<A>(value: ParseResult<A>): A {
	if (!value.ok) throw new Error('invalid fixture')
	return value.value
}
const message = EVERGREEN_OFFER_JOURNEY_V1.bridge[0]
const intent: SendMessageIntent = {
	type: 'SendMessage',
	idempotencyKey: must(parseIntentKey('intent-test')),
	journeyId: must(parseJourneyId('evergreen-offer:journey-test')),
	contactId: must(parseContactId('contact-test')),
	slotId: message.slotId,
	contentResourceId: message.contentResourceId,
	presentation: message.presentation,
	notBefore: must(parseIsoInstant('2026-09-07T10:00:00.000Z')),
	notAfter: must(parseIsoInstant('2026-09-07T12:00:00.000Z')),
	couponId: null,
}
const binding = {
	contentResourceId: message.contentResourceId,
	sequenceId: 17,
	readback: {
		sequenceId: 17,
		repeat: false,
		emailCount: 1,
		published: true,
		active: true,
		hold: false,
	},
}
const subscriber = {
	id: 42,
	first_name: null,
	email_address: 'fixture@example.test',
	state: 'active',
	created_at: '2026-09-01T00:00:00Z',
	added_at: '2026-09-07T11:00:00Z',
	fields: {},
}
function response(body: unknown, status = 201) {
	return new Response(JSON.stringify(body), { status })
}
function setup(
	fetcher = vi
		.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
		.mockResolvedValue(response({ subscriber })),
	bindings: unknown = [binding],
) {
	return {
		fetcher,
		adapter: createKitDeliveryPort({
			fetch: fetcher,
			apiKey: 'test-only',
			bindings,
			resolveIdentity: async () => ({
				contactId: intent.contactId,
				subscriberId: 42,
			}),
			now: () => '2026-09-07T11:00:00.000Z',
			timeoutMs: 50,
		}),
	}
}
const outcome = (adapter: ReturnType<typeof createKitDeliveryPort>) =>
	Effect.runPromise(Effect.either(adapter.apply(intent)))
afterEach(() => {
	vi.useRealTimers()
})

describe('dormant Kit delivery', () => {
	it.each([
		[200, 'already-member'],
		[201, 'added'],
	] as const)(
		'binds %s enrollment, not inbox delivery',
		async (status, marker) => {
			const { adapter, fetcher } = setup(
				vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(response({ subscriber }, status)),
			)
			const result = await outcome(adapter)
			expect(Either.isRight(result)).toBe(true)
			if (Either.isRight(result))
				expect(result.right.providerReceiptId).toBe(
					`kit:sequence:17:subscriber:42:${marker}`,
				)
			expect(fetcher).toHaveBeenCalledTimes(1)
			expect(fetcher).toHaveBeenCalledWith(
				'https://api.kit.com/v4/sequences/17/subscribers/42',
				expect.objectContaining({
					method: 'POST',
					body: '{}',
					redirect: 'error',
				}),
			)
		},
	)
	it.each([401, 403, 404, 422])(
		'refuses known HTTP %s without retry',
		async (status) => {
			const { adapter, fetcher } = setup(
				vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(response({}, status)),
			)
			expect(await outcome(adapter)).toMatchObject({
				_tag: 'Left',
				left: { type: 'EffectPermanentRefusal' },
			})
			expect(fetcher).toHaveBeenCalledTimes(1)
		},
	)
	it.each([429, 500, 503, 202, 302])(
		'holds uncertain HTTP %s without retry',
		async (status) => {
			const { adapter, fetcher } = setup(
				vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(response({}, status)),
			)
			expect(await outcome(adapter)).toMatchObject({
				_tag: 'Left',
				left: { type: 'EffectAmbiguous' },
			})
			expect(fetcher).toHaveBeenCalledTimes(1)
		},
	)
	it.each([
		{},
		{ subscriber: { ...subscriber, id: 43 } },
		{ subscriber, sequence_id: 18 },
		{ subscriber: { ...subscriber, state: 'cancelled' } },
	])('holds malformed or mismatched success', async (body) => {
		const { adapter } = setup(
			vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockResolvedValue(response(body)),
		)
		expect(await outcome(adapter)).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
	})
	it('holds malformed JSON and transport errors', async () => {
		for (const fetcher of [
			vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockResolvedValue(new Response('not json', { status: 201 })),
			vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockRejectedValue(new Error('private transport details')),
		]) {
			expect(await outcome(setup(fetcher).adapter)).toMatchObject({
				_tag: 'Left',
				left: { type: 'EffectAmbiguous' },
			})
			expect(fetcher).toHaveBeenCalledTimes(1)
		}
	})
	it.each(['headers', 'body'])(
		'bounds %s timeout and never retries',
		async (phase) => {
			vi.useFakeTimers()
			const fetcher = vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockImplementation(async () => {
					if (phase === 'headers') return new Promise<Response>(() => {})
					return new Response(new ReadableStream({ start() {} }), {
						status: 201,
					})
				})
			const pending = outcome(setup(fetcher).adapter)
			await vi.advanceTimersByTimeAsync(100)
			expect(await pending).toMatchObject({
				_tag: 'Left',
				left: { type: 'EffectAmbiguous' },
			})
			expect(fetcher).toHaveBeenCalledTimes(1)
		},
	)
	it.each(
		[
			[],
			[{ ...binding, readback: { ...binding.readback, repeat: true } }],
			[{ ...binding, readback: { ...binding.readback, emailCount: 2 } }],
			[{ ...binding, readback: { ...binding.readback, published: false } }],
			[binding, binding],
		].map((bindings) => ({ bindings })),
	)('rejects absent or unsafe binding before I/O', async ({ bindings }) => {
		const { adapter, fetcher } = setup(undefined, bindings)
		expect(await outcome(adapter)).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectPermanentRefusal' },
		})
		expect(fetcher).not.toHaveBeenCalled()
	})
	it('holds response-body read failure with one POST', async () => {
		const reply = response({ subscriber })
		vi.spyOn(reply, 'json').mockRejectedValue(new Error('body disconnected'))
		const { adapter, fetcher } = setup(
			vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockResolvedValue(reply),
		)
		expect(await outcome(adapter)).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
	it('holds a success returned for a different sequence URL', async () => {
		const reply = response({ subscriber })
		Object.defineProperty(reply, 'url', {
			value: 'https://api.kit.com/v4/sequences/18/subscribers/42',
		})
		const { adapter } = setup(
			vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockResolvedValue(reply),
		)
		expect(await outcome(adapter)).toMatchObject({
			_tag: 'Left',
			left: { type: 'EffectAmbiguous' },
		})
	})
	it('will not replay an expired slot', async () => {
		const { adapter, fetcher } = setup()
		const expired = {
			...intent,
			notAfter: must(parseIsoInstant('2026-09-07T10:59:00.000Z')),
		}
		expect(
			await Effect.runPromise(Effect.either(adapter.apply(expired))),
		).toMatchObject({ _tag: 'Left', left: { type: 'EffectPermanentRefusal' } })
		expect(fetcher).not.toHaveBeenCalled()
	})
	it('rejects a contact mismatch and missing credentials before HTTP', async () => {
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
		for (const apiKey of [undefined, 'test-only']) {
			const adapter = createKitDeliveryPort({
				fetch: fetcher,
				bindings: [binding],
				apiKey,
				resolveIdentity: async () => ({ contactId: 'other', subscriberId: 42 }),
				now: () => '2026-09-07T11:00:00.000Z',
			})
			expect(await outcome(adapter)).toMatchObject({
				_tag: 'Left',
				left: { type: 'EffectPermanentRefusal' },
			})
		}
		expect(fetcher).not.toHaveBeenCalled()
	})
})

const page = (ids: number[], more = false, cursor = '') => ({
	subscribers: ids.map((id) => ({ ...subscriber, id })),
	pagination: { has_next_page: more, end_cursor: cursor },
})
describe('read-only reconciliation', () => {
	it.each([
		[page([42]), 'Present'],
		[page([]), 'Absent'],
	] as const)(
		'proves membership only from complete evidence',
		async (body, type) => {
			const { adapter, fetcher } = setup(
				vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(response(body, 200)),
			)
			expect(await Effect.runPromise(adapter.reconcile(intent))).toMatchObject({
				type,
			})
			expect(fetcher).toHaveBeenCalledWith(
				'https://api.kit.com/v4/sequences/17/subscribers?status=all&per_page=100',
				expect.objectContaining({ method: 'GET' }),
			)
		},
	)
	it('follows cursors then proves present, never POSTs', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(response(page([41], true, 'next'), 200))
			.mockResolvedValueOnce(response(page([42]), 200))
		expect(
			await Effect.runPromise(setup(fetcher).adapter.reconcile(intent)),
		).toMatchObject({ type: 'Present' })
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(
			fetcher.mock.calls.every(([, options]) => options?.method === 'GET'),
		).toBe(true)
	})
	it.each([page([], true, 'next'), {}, { ...page([]), truncated: true }])(
		'does not infer absence from incomplete evidence',
		async (body) => {
			const { adapter } = setup(
				vi
					.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
					.mockResolvedValue(response(body, 200)),
			)
			expect(
				await Effect.runPromise(adapter.reconcile(intent, 1)),
			).toMatchObject({ type: 'Unknown' })
		},
	)
	it('unavailable membership is unknown, not an invitation to resend', async () => {
		const { adapter, fetcher } = setup(
			vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockRejectedValue(new Error('offline')),
		)
		expect(await Effect.runPromise(adapter.reconcile(intent))).toMatchObject({
			type: 'Unknown',
		})
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
})
