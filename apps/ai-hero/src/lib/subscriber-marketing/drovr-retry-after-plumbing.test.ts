import { describe, expect, it, vi } from 'vitest'

vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	DrovrBatchDeliveryFailedError,
	deliverBatchOrThrow,
	deliverOrThrow,
	DrovrDeliveryFailedError,
} from './drovr-shadow-delivery'
import {
	deliverDrovrShadowEvent,
	deliverDrovrShadowEventsDirect,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

const config = { ingestUrl: 'https://drovr.test/events', apiKey: 'k' }
const event = (idempotencyKey: string): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	type: 'contact.created',
	occurredAt: '2026-09-30T12:00:00.000Z',
	idempotencyKey,
})
const answer = (status: number, headers: Record<string, string> = {}) =>
	vi.fn(async () => new Response('{}', { status, headers })) as never

describe('drovr status and Retry-After reach the retry decision (row 204)', () => {
	it.each([500, 503])(
		'a single post keeps a %i and its Retry-After',
		async (status) => {
			expect(
				await deliverDrovrShadowEvent({
					clampAt: Date.now(),
					event: event('k'),
					config,
					fetcher: answer(status, { 'retry-after': '30' }),
				}),
			).toEqual({
				status: 'failed',
				httpStatus: status,
				reason: `drovr answered ${status}`,
				retryAfterMs: 30_000,
			})
			const error = await deliverOrThrow({
				clampAt: Date.now(),
				event: event('k'),
				config,
				fetcher: answer(status, { 'retry-after': '30' }),
			}).catch((thrown: unknown) => thrown)
			expect(error).toBeInstanceOf(DrovrDeliveryFailedError)
			expect(error).toMatchObject({ httpStatus: status, retryAfterMs: 30_000 })
		},
	)

	it.each([500, 503])(
		'a batch post keeps a %i and its Retry-After',
		async (status) => {
			const error = await deliverBatchOrThrow({
				clampAt: Date.now(),
				events: [event('a'), event('b')],
				config,
				fetcher: answer(status, { 'retry-after': '45' }),
			}).catch((thrown: unknown) => thrown)
			expect(error).toBeInstanceOf(DrovrBatchDeliveryFailedError)
			expect(error).toMatchObject({ httpStatus: status, retryAfterMs: 45_000 })
		},
	)

	it('the direct sender answers with what drovr did not take', async () => {
		const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
			const sent = JSON.parse(String(init.body)) as DrovrShadowEvent
			const status =
				sent.idempotencyKey === 'down'
					? 503
					: sent.idempotencyKey === 'bad'
						? 422
						: 200
			return new Response('{}', { status })
		}) as never
		const unsent = await deliverDrovrShadowEventsDirect(
			[event('ok'), event('down'), event('bad')],
			{
				readBirthOptOuts: async () => [],
				config: { ingestUrl: config.ingestUrl, authorityApiKey: 'k' },
				fetch: fetcher,
				warn: vi.fn(),
				info: vi.fn(),
			},
		)
		// A 4xx is final and warned, never outboxed.
		expect(unsent.map((sent) => sent.idempotencyKey)).toEqual(['down'])
	})

	it('the direct sender answers a refused stop too, so it is outboxed and its gate closes (row 204c)', async () => {
		const stop = {
			...event('stop'),
			type: 'contact.unsubscribed',
		} as DrovrShadowEvent
		const unsent = await deliverDrovrShadowEventsDirect([event('fact'), stop], {
			readBirthOptOuts: async () => [],
			config: { ingestUrl: config.ingestUrl, authorityApiKey: 'k' },
			fetch: vi.fn(async () => new Response('{}', { status: 404 })) as never,
			warn: vi.fn(),
			info: vi.fn(),
		})
		expect(unsent.map((sent) => sent.idempotencyKey)).toEqual(['stop'])
	})

	it('the direct sender answers a network failure as unsent', async () => {
		const unsent = await deliverDrovrShadowEventsDirect([event('net')], {
			readBirthOptOuts: async () => [],
			config: { ingestUrl: config.ingestUrl, authorityApiKey: 'k' },
			fetch: vi.fn(async () => {
				throw new TypeError('fetch failed')
			}) as never,
			warn: vi.fn(),
			info: vi.fn(),
		})
		expect(unsent.map((sent) => sent.idempotencyKey)).toEqual(['net'])
	})
})
