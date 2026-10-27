import { afterEach, describe, expect, it, vi } from 'vitest'

import { readDrovrOptOuts } from './drovr-opt-out-reader'

const identity = {
	identities: [{ kitSubscriberId: '123', contactId: 'contact-1' }],
}
const stop = (reason = 'unsubscribed') => ({
	contactId: 'contact-1',
	scope: 'all',
	lifted: false,
	reason,
})
const reply = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200 })
const setup = () => {
	const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
	return {
		fetcher,
		config: {
			baseUrl: 'https://drovr.test/',
			apiKey: 'test-key',
			fetch: fetcher,
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('readDrovrOptOuts', () => {
	it('uses the tenant bearer and confirmed REST payloads, never an address', async () => {
		const { fetcher, config } = setup()
		fetcher
			.mockResolvedValueOnce(reply(identity))
			.mockResolvedValueOnce(
				reply({ suppressions: [stop()], nextCursor: null }),
			)
		const onUnexpectedPage = vi.fn()
		await expect(
			readDrovrOptOuts('123', config, onUnexpectedPage),
		).resolves.toEqual([{ reason: 'unsubscribed' }])
		expect(onUnexpectedPage).not.toHaveBeenCalled()
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			'https://drovr.test/journeys/contact-directory/identities',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ kitSubscriberIds: ['123'] }),
				headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
			}),
		)
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			'https://drovr.test/suppressions?contactId=contact-1&scope=all&activeOnly=true',
			expect.objectContaining({
				method: 'GET',
				signal: expect.any(AbortSignal),
			}),
		)
	})

	it('no directory match means no stops and no second request', async () => {
		const { fetcher, config } = setup()
		fetcher.mockResolvedValue(reply({ identities: [] }))
		await expect(readDrovrOptOuts('123', config)).resolves.toEqual([])
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it('warns once when requesting a second page and still reads every page', async () => {
		const { fetcher, config } = setup()
		const onUnexpectedPage = vi.fn()
		fetcher
			.mockResolvedValueOnce(reply(identity))
			.mockResolvedValueOnce(reply({ suppressions: [], nextCursor: 'next/1' }))
			.mockResolvedValueOnce(reply({ suppressions: [], nextCursor: 'next/2' }))
			.mockResolvedValueOnce(
				reply({ suppressions: [stop('bounced')], nextCursor: null }),
			)
		await expect(
			readDrovrOptOuts('123', config, onUnexpectedPage),
		).resolves.toEqual([{ reason: 'bounced' }])
		expect(fetcher.mock.calls[2]![0]).toContain('cursor=next%2F1')
		expect(fetcher.mock.calls[3]![0]).toContain('cursor=next%2F2')
		expect(onUnexpectedPage).toHaveBeenCalledTimes(1)
		expect(onUnexpectedPage).toHaveBeenCalledWith()
	})

	it('no active stops returns an empty result', async () => {
		const { fetcher, config } = setup()
		fetcher
			.mockResolvedValueOnce(reply(identity))
			.mockResolvedValueOnce(reply({ suppressions: [], nextCursor: null }))
		await expect(readDrovrOptOuts('123', config)).resolves.toEqual([])
	})

	it.each([0, 1])('non-2xx on read %s throws without retry', async (stage) => {
		const { fetcher, config } = setup()
		if (stage) fetcher.mockResolvedValueOnce(reply(identity))
		fetcher.mockResolvedValueOnce(
			new Response('private response', { status: 503 }),
		)
		await expect(readDrovrOptOuts('123', config)).rejects.toThrow(
			'Drovr opt-out read failed',
		)
		expect(fetcher).toHaveBeenCalledTimes(stage + 1)
	})

	it('network failure throws without retry', async () => {
		const { fetcher, config } = setup()
		fetcher.mockRejectedValue(new TypeError('unreachable'))
		await expect(readDrovrOptOuts('123', config)).rejects.toThrow(TypeError)
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it.each(['fetch', 'body'])(
		'one 1.5s deadline bounds a stalled %s',
		async (stage) => {
			vi.useFakeTimers()
			const { fetcher, config } = setup()
			if (stage === 'fetch')
				fetcher.mockImplementation(() => new Promise(() => {}))
			else {
				fetcher.mockResolvedValueOnce(reply(identity)).mockResolvedValueOnce({
					ok: true,
					json: () => new Promise(() => {}),
				} as unknown as Response)
			}
			const result = readDrovrOptOuts('123', config)
			const assertion = expect(result).rejects.toMatchObject({
				name: 'TimeoutError',
			})
			await vi.advanceTimersByTimeAsync(1500)
			await assertion
			expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(
				true,
			)
			expect(fetcher).toHaveBeenCalledTimes(stage === 'fetch' ? 1 : 2)
		},
	)

	it('does not reset the deadline between identity and suppression reads', async () => {
		vi.useFakeTimers()
		const { fetcher, config } = setup()
		fetcher
			.mockImplementationOnce(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve(reply(identity)), 1000),
					),
			)
			.mockImplementationOnce(() => new Promise(() => {}))
		const assertion = expect(
			readDrovrOptOuts('123', config),
		).rejects.toMatchObject({ name: 'TimeoutError' })
		await vi.advanceTimersByTimeAsync(1499)
		expect((fetcher.mock.calls[1]![1]!.signal as AbortSignal).aborted).toBe(
			false,
		)
		await vi.advanceTimersByTimeAsync(1)
		await assertion
	})

	it('unreadable responses and mismatched contacts are not an empty stop list', async () => {
		for (const body of [
			{},
			{ suppressions: [stop()], nextCursor: undefined },
			{ suppressions: [{ ...stop(), contactId: 'other' }], nextCursor: null },
		]) {
			const { fetcher, config } = setup()
			fetcher
				.mockResolvedValueOnce(reply(identity))
				.mockResolvedValueOnce(reply(body))
			await expect(readDrovrOptOuts('123', config)).rejects.toThrow()
		}
	})

	it('missing configuration cannot be mistaken for no stops', async () => {
		await expect(readDrovrOptOuts('123', undefined)).rejects.toThrow(
			'not configured',
		)
	})
})
