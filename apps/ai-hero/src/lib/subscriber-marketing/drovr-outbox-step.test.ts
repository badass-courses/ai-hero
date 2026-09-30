import { describe, expect, it, vi } from 'vitest'

import { drovrRetryWindowMs, outboxEntryForEvent } from './drovr-outbox'
import {
	isFinalDrovrSendAttempt,
	sendOrOutbox,
	type DrovrOutboxCaptureFn,
} from './drovr-outbox-step'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const body: DrovrShadowEvent = {
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	type: 'contact.created',
	occurredAt: '2026-09-30T12:00:00.000Z',
	idempotencyKey: 'owner:birth',
}

const failure = (httpStatus: number, retryAfterMs?: number) =>
	Object.assign(new Error(`drovr answered ${httpStatus}`), {
		httpStatus,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	})

const run = (
	attempt: { attempt: number; maxAttempts?: number },
	send: () => Promise<string>,
	capture: DrovrOutboxCaptureFn = vi.fn(
		async (entries: readonly unknown[]) => ({
			status: 'outboxed' as const,
			count: entries.length,
		}),
	),
) => ({
	capture,
	result: sendOrOutbox({
		attempt,
		send,
		unsent: () => [outboxEntryForEvent(body, 'live')],
		capture,
		outboxed: (count) => `outboxed:${count}`,
	}),
})

describe('sendOrOutbox', () => {
	it('returns what the send returns', async () => {
		expect(await run({ attempt: 0 }, async () => 'sent').result).toBe('sent')
	})

	it.each([500, 503])(
		'rethrows a %i before the last attempt as RetryAfterError on the table',
		async (httpStatus) => {
			const { result, capture } = run({ attempt: 3, maxAttempts: 9 }, () =>
				Promise.reject(failure(httpStatus, 5_000)),
			)
			await expect(result).rejects.toMatchObject({
				name: 'RetryAfterError',
				retryAfter: '120',
				message: `drovr answered ${httpStatus}`,
			})
			expect(capture).not.toHaveBeenCalled()
		},
	)

	it.each([500, 503])(
		'outboxes the unsent entries on the last attempt of a %i',
		async (httpStatus) => {
			const error = failure(httpStatus)
			const { result, capture } = run({ attempt: 8, maxAttempts: 9 }, () =>
				Promise.reject(error),
			)
			expect(await result).toBe('outboxed:1')
			expect(capture).toHaveBeenCalledWith(
				[expect.objectContaining({ idempotencyKey: 'owner:birth' })],
				error,
			)
		},
	)

	it.each(['unavailable', 'unconfigured'] as const)(
		'rethrows the original error on the last attempt when the outbox is %s',
		async (status) => {
			const error = failure(503)
			const { result } = run(
				{ attempt: 8, maxAttempts: 9 },
				() => Promise.reject(error),
				vi.fn(async () => ({ status })),
			)
			await expect(result).rejects.toBe(error)
		},
	)

	it('passes a NonRetriableError straight through, never outboxed', async () => {
		const error = Object.assign(new Error('refused'), {
			name: 'NonRetriableError',
		})
		const { result, capture } = run({ attempt: 8, maxAttempts: 9 }, () =>
			Promise.reject(error),
		)
		await expect(result).rejects.toBe(error)
		expect(capture).not.toHaveBeenCalled()
	})

	it('reads the last attempt from maxAttempts, else from the retry budget', () => {
		expect(isFinalDrovrSendAttempt({ attempt: 8, maxAttempts: 9 })).toBe(true)
		expect(isFinalDrovrSendAttempt({ attempt: 7, maxAttempts: 9 })).toBe(false)
		expect(isFinalDrovrSendAttempt({ attempt: 8 })).toBe(true)
		expect(isFinalDrovrSendAttempt({ attempt: 2, maxAttempts: 3 })).toBe(true)
		// A caller without the context fields: the first attempt, not the last.
		expect(
			isFinalDrovrSendAttempt({ attempt: undefined as unknown as number }),
		).toBe(false)
	})
})

describe('contactSyncSendOrOutbox', () => {
	it('outboxes a contact-sync batch on the last attempt, as nothing accepted or refused', async () => {
		const { contactSyncSendOrOutbox } =
			await import('./drovr-outbox-contact-sync')
		const capture = vi.fn(async (entries: readonly unknown[]) => ({
			status: 'outboxed' as const,
			count: entries.length,
		}))
		const outboxing = contactSyncSendOrOutbox(
			{ attempt: 8, maxAttempts: 9 },
			capture,
		)
		expect(await outboxing([body], () => Promise.reject(failure(503)))).toEqual(
			{ accepted: 0, rejected: 0 },
		)
		expect(capture).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					source: 'contactSync',
					idempotencyKey: 'owner:birth',
				}),
			],
			expect.anything(),
		)
	})
})

describe('sendOrOutbox: a stop is captured on its first failure (row 204b round 2)', () => {
	const stop = outboxEntryForEvent(
		{ ...body, type: 'purchase.recorded', idempotencyKey: 'purchase:1' },
		'live',
	)
	const NOW = new Date('2026-09-30T12:00:00.000Z')
	const early = () => {
		const settle = vi.fn(async () => 1)
		return { settle, early: { stops: () => [stop], settle } }
	}
	const capturing = () =>
		vi.fn(async (entries: readonly unknown[]) => ({
			status: 'outboxed' as const,
			count: entries.length,
		}))

	it("sums the rest of Inngest's retries: 78.75 minutes from the first failure, this retry's Retry-After honoured", () => {
		expect(drovrRetryWindowMs(0, 9)).toBe(78.75 * 60_000)
		expect(drovrRetryWindowMs(7, 9)).toBe(40 * 60_000)
		expect(drovrRetryWindowMs(0, 9, 10 * 60_000)).toBe(
			78.75 * 60_000 - 15_000 + 10 * 60_000,
		)
	})

	it('captures the stop on the first failure, due only when the retries run out, and still retries', async () => {
		const capture = capturing()
		const { early: hook, settle } = early()
		const result = sendOrOutbox({
			attempt: { attempt: 0, maxAttempts: 9 },
			send: () => Promise.reject(failure(503)),
			unsent: () => [stop],
			capture,
			outboxed: (count) => `outboxed:${count}`,
			early: hook,
			now: () => NOW,
		})
		await expect(result).rejects.toMatchObject({ name: 'RetryAfterError' })
		expect(capture).toHaveBeenCalledOnce()
		expect(capture).toHaveBeenCalledWith([stop], expect.any(Error), {
			nextAttemptAt: new Date(NOW.getTime() + 78.75 * 60_000),
		})
		expect(settle).not.toHaveBeenCalled()
	})

	it('captures nothing early when the step has no stops', async () => {
		const capture = capturing()
		await expect(
			sendOrOutbox({
				attempt: { attempt: 0, maxAttempts: 9 },
				send: () => Promise.reject(failure(503)),
				unsent: () => [stop],
				capture,
				outboxed: (count) => `outboxed:${count}`,
				early: { stops: () => [], settle: vi.fn() },
			}),
		).rejects.toMatchObject({ name: 'RetryAfterError' })
		expect(capture).not.toHaveBeenCalled()
	})

	it('keeps retrying when the early capture itself throws', async () => {
		const capture = vi.fn(async () => {
			throw new Error('database down')
		})
		await expect(
			sendOrOutbox({
				attempt: { attempt: 0, maxAttempts: 9 },
				send: () => Promise.reject(failure(503)),
				unsent: () => [stop],
				capture,
				outboxed: (count) => `outboxed:${count}`,
				early: early().early,
			}),
		).rejects.toMatchObject({ name: 'RetryAfterError' })
	})

	it('settles the captured stop when a later retry lands, and only then', async () => {
		const later = early()
		expect(
			await sendOrOutbox({
				attempt: { attempt: 2, maxAttempts: 9 },
				send: async () => 'sent',
				unsent: () => [stop],
				capture: capturing(),
				outboxed: (count) => `outboxed:${count}`,
				early: later.early,
			}),
		).toBe('sent')
		expect(later.settle).toHaveBeenCalledWith(
			[stop],
			'delivered by an Inngest retry',
		)
		const first = early()
		await sendOrOutbox({
			attempt: { attempt: 0, maxAttempts: 9 },
			send: async () => 'sent',
			unsent: () => [stop],
			capture: capturing(),
			outboxed: (count) => `outboxed:${count}`,
			early: first.early,
		})
		expect(first.settle).not.toHaveBeenCalled()
	})

	it('outboxes the whole step on the last attempt, as before', async () => {
		const capture = capturing()
		expect(
			await sendOrOutbox({
				attempt: { attempt: 8, maxAttempts: 9 },
				send: () => Promise.reject(failure(503)),
				unsent: () => [stop],
				capture,
				outboxed: (count) => `outboxed:${count}`,
				early: early().early,
			}),
		).toBe('outboxed:1')
		expect(capture).toHaveBeenCalledWith([stop], expect.any(Error))
	})
})
