import { afterEach, describe, expect, it, vi } from 'vitest'

import { readDrovrOptOuts } from './drovr-opt-out-reader'

const body = (stops: unknown[], kitSubscriberId = '123') => ({
	kitSubscriberId,
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	stops,
})
const stop = (reason = 'unsubscribed') => ({
	scope: 'all',
	reason,
	createdAt: '2026-10-27T00:00:00Z',
})
const reply = (json: unknown, status = 200) =>
	new Response(JSON.stringify(json), { status })
const setup = () => {
	const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
	const onRead = vi.fn()
	return {
		fetcher,
		onRead,
		config: {
			baseUrl: 'https://drovr.test/',
			apiKey: 'test-key',
			fetch: fetcher,
			onRead,
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('readDrovrOptOuts', () => {
	it('one GET with the tenant bearer and the Kit id, never an address', async () => {
		const { fetcher, config } = setup()
		fetcher.mockResolvedValue(reply(body([stop()])))
		await expect(readDrovrOptOuts('123', config)).resolves.toEqual([
			{ reason: 'unsubscribed' },
		])
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/kit-subscriber-stops?kitSubscriberId=123',
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
				signal: expect.any(AbortSignal),
			}),
		)
	})

	it('clear: 200 with no stops, even when no contact matched', async () => {
		const { fetcher, config } = setup()
		fetcher.mockResolvedValue(
			reply({ ...body([]), contactId: null }),
		)
		await expect(readDrovrOptOuts('123', config)).resolves.toEqual([])
	})

	it('block: returns every stop reason', async () => {
		const { fetcher, config } = setup()
		fetcher.mockResolvedValue(reply(body([stop(), stop('bounced')])))
		await expect(readDrovrOptOuts('123', config)).resolves.toEqual([
			{ reason: 'unsubscribed' },
			{ reason: 'bounced' },
		])
	})

	it.each([503, 403, 500, 404])('HTTP %s throws, never clear', async (code) => {
		const { fetcher, config } = setup()
		fetcher.mockResolvedValue(new Response('private', { status: code }))
		await expect(readDrovrOptOuts('123', config)).rejects.toThrow(
			'Drovr opt-out read failed',
		)
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it('network failure throws without retry', async () => {
		const { fetcher, config } = setup()
		fetcher.mockRejectedValue(new TypeError('unreachable'))
		await expect(readDrovrOptOuts('123', config)).rejects.toThrow(TypeError)
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it.each([
		['empty object', {}],
		['stops missing', { kitSubscriberId: '123' }],
		['stops not an array', { kitSubscriberId: '123', stops: null }],
		['non-all scope', body([{ scope: 'journey', reason: 'x' }])],
		['empty reason', body([{ scope: 'all', reason: '' }])],
		['mismatched subscriber id', body([], '999')],
	])('malformed body (%s) throws, never clear', async (_name, json) => {
		const { fetcher, config } = setup()
		fetcher.mockResolvedValue(reply(json))
		await expect(readDrovrOptOuts('123', config)).rejects.toThrow()
	})

	it.each(['fetch', 'body'])(
		'one 6s deadline bounds a stalled %s',
		async (stage) => {
			vi.useFakeTimers()
			const { fetcher, config } = setup()
			if (stage === 'fetch')
				fetcher.mockImplementation(() => new Promise(() => {}))
			else {
				fetcher.mockResolvedValue({
					ok: true,
					status: 200,
					json: () => new Promise(() => {}),
				} as unknown as Response)
			}
			const result = readDrovrOptOuts('123', config)
			const assertion = expect(result).rejects.toMatchObject({
				name: 'TimeoutError',
			})
			await vi.advanceTimersByTimeAsync(5999)
			expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(
				false,
			)
			await vi.advanceTimersByTimeAsync(1)
			await assertion
			expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(
				true,
			)
		},
	)

	it('reports latency and status per call, with no ids', async () => {
		const { fetcher, config, onRead } = setup()
		fetcher.mockResolvedValueOnce(reply(body([])))
		await readDrovrOptOuts('123', config)
		fetcher.mockResolvedValueOnce(new Response('', { status: 503 }))
		await readDrovrOptOuts('123', config).catch(() => {})
		fetcher.mockRejectedValueOnce(new TypeError('x'))
		await readDrovrOptOuts('123', config).catch(() => {})
		expect(onRead.mock.calls.map(([o]) => o.status)).toEqual([200, 503, 'error'])
		expect(onRead.mock.calls.every(([o]) => typeof o.ms === 'number')).toBe(true)
	})

	it('a failing observer never changes the answer', async () => {
		const { fetcher, config, onRead } = setup()
		onRead.mockRejectedValue(new Error('log down'))
		fetcher.mockResolvedValue(reply(body([])))
		await expect(readDrovrOptOuts('123', config)).resolves.toEqual([])
	})

	it('not configured throws', async () => {
		await expect(readDrovrOptOuts('123', undefined)).rejects.toThrow()
	})
})
