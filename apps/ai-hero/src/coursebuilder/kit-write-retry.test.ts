import { describe, expect, it } from 'vitest'

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

import {
	KIT_RATE_LIMIT_DELAY_MS,
	KIT_RATE_LIMIT_JITTER_MS,
	KIT_SERVER_ERROR_BASE_DELAY_MS,
	kitWriteRetrySchedule,
} from './kit-write-retry'

function kitError(
	status: number,
	responseHeaders: Record<string, string> = {},
) {
	return new ConvertKitApiError({
		message: `Kit failed with ${status}`,
		status,
		statusText: 'Error',
		bodySnippet: '',
		responseHeaders,
	})
}

describe('kitWriteRetrySchedule', () => {
	it('schedules a 429 after the rolling rate-limit window', () => {
		expect(kitWriteRetrySchedule(kitError(429), { random: () => 0.5 })).toEqual(
			{
				status: 429,
				delayMs: KIT_RATE_LIMIT_DELAY_MS + KIT_RATE_LIMIT_JITTER_MS / 2,
				delaySource: 'rate-limit-window',
			},
		)
	})

	it.each([500, 503])(
		'schedules Kit HTTP %s with short server-error backoff',
		(status) => {
			expect(
				kitWriteRetrySchedule(kitError(status), {
					attempt: 2,
					random: () => 0,
				}),
			).toEqual({
				status,
				delayMs: KIT_SERVER_ERROR_BASE_DELAY_MS * 2,
				delaySource: 'server-error',
			})
		},
	)

	it('honors a Retry-After seconds header', () => {
		expect(
			kitWriteRetrySchedule(kitError(429, { 'retry-after': '10' })),
		).toEqual({
			status: 429,
			delayMs: 10_000,
			delaySource: 'retry-after',
		})
	})

	it('honors a Retry-After HTTP date header', () => {
		const now = Date.parse('2026-08-17T20:00:00.000Z')
		expect(
			kitWriteRetrySchedule(
				kitError(429, {
					'retry-after': 'Mon, 17 Aug 2026 20:00:30 GMT',
				}),
				{ now: () => now },
			),
		).toEqual({
			status: 429,
			delayMs: 30_000,
			delaySource: 'retry-after',
		})
	})

	it('keeps a Retry-After longer than the rolling-window fallback', () => {
		expect(
			kitWriteRetrySchedule(kitError(429, { 'retry-after': '120' })),
		).toEqual({
			status: 429,
			delayMs: 120_000,
			delaySource: 'retry-after',
		})
	})

	it('does not schedule non-retryable provider responses', () => {
		expect(kitWriteRetrySchedule(kitError(400))).toBeUndefined()
		expect(
			kitWriteRetrySchedule(new Error('network unavailable')),
		).toBeUndefined()
	})

	it('jitters concurrent 429 schedules across the rolling-window boundary', () => {
		const delays = [0, 0.5, 1].map(
			(randomValue) =>
				kitWriteRetrySchedule(kitError(429), {
					random: () => randomValue,
				})?.delayMs,
		)

		expect(delays).toEqual([
			KIT_RATE_LIMIT_DELAY_MS,
			KIT_RATE_LIMIT_DELAY_MS + KIT_RATE_LIMIT_JITTER_MS / 2,
			KIT_RATE_LIMIT_DELAY_MS + KIT_RATE_LIMIT_JITTER_MS,
		])
	})
})
