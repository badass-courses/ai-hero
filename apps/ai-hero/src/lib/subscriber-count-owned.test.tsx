import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ kitTotal: vi.fn(), warn: vi.fn() }))
vi.mock('@/lib/kit-data', () => ({ getTotalSubscribers: mocks.kitTotal }))
vi.mock('./kit-data', () => ({ getTotalSubscribers: mocks.kitTotal }))
vi.mock('@/server/logger', () => ({ log: { warn: mocks.warn } }))

import { SubscriberCount } from '@/components/subscriber-count'

// Today's render when the count is unavailable.
const FALLBACK = '90,000+'
const body = {
	asOf: '2026-10-31T00:00:00Z',
	tenantId: 'org-aihero',
	total: 123_456,
}
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status })

async function render() {
	return renderToStaticMarkup(await SubscriberCount({}))
}

let fetcher: ReturnType<typeof vi.fn>

beforeEach(() => {
	mocks.kitTotal.mockReset().mockResolvedValue(98_765)
	mocks.warn.mockReset()
	fetcher = vi.fn()
	vi.stubGlobal('fetch', fetcher)
	vi.stubEnv('DROVR_API_BASE_URL', 'https://drovr.example.test')
	vi.stubEnv('DROVR_API_KEY_ORG_AIHERO', 'synthetic-key')
	vi.stubEnv('AIH_SUBSCRIBER_COUNT_OWNED_ENABLED', 'true')
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('SubscriberCount with AIH_SUBSCRIBER_COUNT_OWNED_ENABLED', () => {
	it('renders drovr census total with the existing rounding', async () => {
		fetcher.mockResolvedValue(json(body))

		expect(await render()).toBe('123,400+')
		expect(String(fetcher.mock.calls[0]![0])).toBe(
			'https://drovr.example.test/audience-total',
		)
		expect(mocks.kitTotal).not.toHaveBeenCalled()
		expect(mocks.warn).not.toHaveBeenCalled()
	})

	it.each([
		['503 unavailable', () => json({ title: 'AudienceTotalUnavailable' }, 503)],
		['403 forbidden', () => json({ title: 'AudienceTotalForbidden' }, 403)],
		['malformed JSON', () => new Response('{not json', { status: 200 })],
		['a foreign tenant', () => json({ ...body, tenantId: 'org-other' })],
		['a zero total', () => json({ ...body, total: 0 })],
		['a missing total', () => json({ asOf: body.asOf, tenantId: body.tenantId })],
	])('renders today’s fallback and logs once on %s', async (_, reply) => {
		fetcher.mockResolvedValue(reply())

		expect(await render()).toBe(FALLBACK)
		expect(mocks.warn).toHaveBeenCalledTimes(1)
		expect(mocks.warn.mock.calls[0]![0]).toBe(
			'subscriber_count.owned.unavailable',
		)
		expect(mocks.kitTotal).not.toHaveBeenCalled()
	})

	it('gives up after five seconds and renders the fallback', async () => {
		vi.useFakeTimers()
		fetcher.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError')),
					)
				}),
		)

		const rendered = render()
		await vi.advanceTimersByTimeAsync(4_999)
		expect(mocks.warn).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)

		expect(await rendered).toBe(FALLBACK)
		expect(mocks.warn).toHaveBeenCalledWith(
			'subscriber_count.owned.unavailable',
			{ reason: 'drovr audience-total timed out' },
		)
	})

	it('renders the fallback without a call when drovr is not configured', async () => {
		vi.stubEnv('DROVR_API_KEY_ORG_AIHERO', '')

		expect(await render()).toBe(FALLBACK)
		expect(fetcher).not.toHaveBeenCalled()
		expect(mocks.warn).toHaveBeenCalledTimes(1)
	})

	it.each(['', 'false', 'TRUE', '1'])(
		'keeps the Kit read and never calls drovr when the flag is %j',
		async (flag) => {
			vi.stubEnv('AIH_SUBSCRIBER_COUNT_OWNED_ENABLED', flag)

			expect(await render()).toBe('98,700+')
			expect(fetcher).not.toHaveBeenCalled()
			expect(mocks.kitTotal).toHaveBeenCalledTimes(1)
		},
	)
})
