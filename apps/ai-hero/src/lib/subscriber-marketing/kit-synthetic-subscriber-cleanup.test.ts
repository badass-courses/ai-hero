import { describe, expect, it } from 'vitest'

import { unsubscribeSyntheticKitSubscriber } from './kit-synthetic-subscriber-cleanup'

const email = 'joel+aih-synth-canary-learner-v1-test@badass.dev'
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	})

function responseQueue(values: Array<Response | (() => Response)>) {
	const calls: Array<{ url: string; init?: RequestInit }> = []
	const fetcher = async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
		const next = values.shift()
		if (!next) throw new Error('Unexpected fetch')
		return typeof next === 'function' ? next() : next
	}
	return { calls, fetcher }
}

describe('synthetic Kit subscriber cleanup', () => {
	it('refuses addresses outside the exact synthetic namespace', async () => {
		const { calls, fetcher } = responseQueue([])
		await expect(
			unsubscribeSyntheticKitSubscriber({
				email: 'person@example.com',
				apiKey: 'test-key',
				fetcher,
			}),
		).rejects.toThrow('outside the synthetic namespace')
		expect(calls).toHaveLength(0)
	})

	it('treats a missing synthetic subscriber as a safe idempotent cleanup', async () => {
		const { fetcher } = responseQueue([
			json({ subscribers: [], pagination: { has_next_page: false } }),
		])
		await expect(
			unsubscribeSyntheticKitSubscriber({ email, apiKey: 'test-key', fetcher }),
		).resolves.toEqual({ status: 'not-found', readbackAttempts: 0 })
	})

	it('fails closed on a malformed successful list response', async () => {
		const { fetcher } = responseQueue([json({})])
		await expect(
			unsubscribeSyntheticKitSubscriber({ email, apiKey: 'test-key', fetcher }),
		).rejects.toThrow('provider list response was malformed')
	})

	it.each([
		{ subscribers: [{}] },
		{
			subscribers: [
				{ id: 42, email_address: 'other@example.com', state: 'active' },
			],
		},
	])('fails closed on a malformed or mismatched non-empty list', async (body) => {
		const { fetcher } = responseQueue([json(body)])
		await expect(
			unsubscribeSyntheticKitSubscriber({ email, apiKey: 'test-key', fetcher }),
		).rejects.toThrow(/provider (list response was malformed|returned a mismatched subscriber)/)
	})

	it('treats an already-cancelled subscriber as idempotent success', async () => {
		const { calls, fetcher } = responseQueue([
			json({
				subscribers: [
					{ id: 42, email_address: email, state: 'cancelled' },
				],
			}),
		])
		await expect(
			unsubscribeSyntheticKitSubscriber({ email, apiKey: 'test-key', fetcher }),
		).resolves.toEqual({ status: 'already-cancelled', readbackAttempts: 1 })
		expect(calls).toHaveLength(1)
	})

	it('does not retry a non-retryable provider response', async () => {
		const { calls, fetcher } = responseQueue([json({}, 401)])
		await expect(
			unsubscribeSyntheticKitSubscriber({ email, apiKey: 'test-key', fetcher }),
		).rejects.toThrow('provider returned HTTP 401')
		expect(calls).toHaveLength(1)
	})

	it.each([
		'joel+certtest@egghead.io',
		'joel+aih-synth-1712345678901@badass.dev',
		'joel+aih-synth-drill-drift-v1-run-1@badass.dev',
		'joel+aih-synth-drill-zombie-v1-run-1@badass.dev',
	])('allows the reserved synthetic address %s', async (reservedEmail) => {
		const { fetcher } = responseQueue([json({ subscribers: [] })])
		await expect(
			unsubscribeSyntheticKitSubscriber({
				email: reservedEmail,
				apiKey: 'test-key',
				fetcher,
			}),
		).resolves.toEqual({ status: 'not-found', readbackAttempts: 0 })
	})

	it('unsubscribes and verifies cancelled state without returning provider ids', async () => {
		const { calls, fetcher } = responseQueue([
			json({
				subscribers: [{ id: 42, email_address: email, state: 'active' }],
				pagination: { has_next_page: false },
			}),
			json({}),
			json({
				subscriber: { id: 42, email_address: email, state: 'cancelled' },
			}),
		])
		const result = await unsubscribeSyntheticKitSubscriber({
			email,
			apiKey: 'test-key',
			fetcher,
			sleep: async () => undefined,
		})
		expect(result).toEqual({ status: 'cancelled', readbackAttempts: 1 })
		expect(JSON.stringify(result)).not.toContain('42')
		expect(calls[1]).toMatchObject({
			url: 'https://api.kit.com/v4/subscribers/42/unsubscribe',
			init: { method: 'POST' },
		})
	})

	it('fails closed when cancelled state does not persist', async () => {
		const { fetcher } = responseQueue([
			json({
				subscribers: [{ id: 42, email_address: email, state: 'active' }],
				pagination: { has_next_page: false },
			}),
			json({}),
			() =>
				json({
					subscriber: { id: 42, email_address: email, state: 'active' },
				}),
			() =>
				json({
					subscriber: { id: 42, email_address: email, state: 'active' },
				}),
		])
		await expect(
			unsubscribeSyntheticKitSubscriber({
				email,
				apiKey: 'test-key',
				fetcher,
				sleep: async () => undefined,
				readbackAttempts: 2,
			}),
		).rejects.toThrow('cancelled state did not persist')
	})
})
