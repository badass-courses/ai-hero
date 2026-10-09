import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	env: {
		DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events' as string | undefined,
	},
	key: vi.fn(),
	fetch: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('./drovr-shadow-emitter', () => ({ drovrApiKeyForTenant: mocks.key }))
import { readDrovrCertificateCompletion } from './drovr-certificate-completion'

const receipt = {
	contactId: 'test-contact',
	journeyId: 'value-path-skills-course',
	email: 'ai-hero-skills-workflow.email-6',
	status: 'delivered',
	provider: 'postshiba',
	route: 'postshiba',
	deliveredAt: '2026-07-18T12:00:00.000Z',
}
beforeEach(() => {
	vi.resetAllMocks()
	mocks.env.DROVR_SHADOW_INGEST_URL = 'https://drovr.test/events'
	mocks.key.mockReturnValue('test-server-key')
	vi.stubGlobal('fetch', mocks.fetch)
	mocks.fetch.mockResolvedValue(Response.json(receipt))
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('read-only drovr email 6 evidence', () => {
	it.each(['postshiba', 'kit'])(
		'accepts validated %s delivery',
		async (provider) => {
			mocks.fetch.mockResolvedValue(Response.json({ ...receipt, provider }))
			expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
				status: 'completed',
				completedAt: new Date(receipt.deliveredAt),
			})
			expect(mocks.key).toHaveBeenCalledWith('org-aihero')
			const [url, options] = mocks.fetch.mock.calls[0]!
			expect(String(url)).toBe(
				'https://drovr.test/email-delivery?contact=test-contact&email=ai-hero-skills-workflow.email-6',
			)
			expect(options).toMatchObject({
				method: 'GET',
				headers: { Authorization: 'Bearer test-server-key' },
				cache: 'no-store',
				redirect: 'error',
			})
			expect(options.signal).toBeInstanceOf(AbortSignal)
			expect(mocks.fetch).toHaveBeenCalledTimes(1)
		},
	)
	it.each(['pending', 'not-started', 'not-routed'])(
		'does not grant %s',
		async (status) => {
			mocks.fetch.mockResolvedValue(
				Response.json({
					...receipt,
					status,
					provider: null,
					deliveredAt: null,
				}),
			)
			expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
				status: 'not-completed',
			})
		},
	)
	it.each([
		{ contactId: 'other' },
		{ journeyId: 'other' },
		{ email: 'ai-hero-skills-workflow.email-7' },
		{ provider: 'unknown' },
		{ provider: null },
		{ deliveredAt: 'invalid' },
		{ deliveredAt: '2999-01-01T00:00:00Z' },
		{ deliveredAt: null },
		{ route: 'unknown' },
		{ status: 'accepted' },
		{ status: 'pending', deliveredAt: receipt.deliveredAt },
	])('rejects malformed or mismatched evidence %j', async (patch) => {
		mocks.fetch.mockResolvedValue(Response.json({ ...receipt, ...patch }))
		expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
			status: 'unavailable',
		})
	})
	it.each([401, 403, 404, 429, 500, 503])(
		'treats HTTP %s as unavailable without retry',
		async (status) => {
			mocks.fetch.mockResolvedValue(new Response('', { status }))
			expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
				status: 'unavailable',
			})
			expect(mocks.fetch).toHaveBeenCalledTimes(1)
		},
	)
	it.each(['credential', 'endpoint'])(
		'fails closed without %s',
		async (missing) => {
			if (missing === 'credential') mocks.key.mockReturnValue(undefined)
			else mocks.env.DROVR_SHADOW_INGEST_URL = undefined
			expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
				status: 'unavailable',
			})
			expect(mocks.fetch).not.toHaveBeenCalled()
		},
	)
	it('rejects malformed JSON', async () => {
		mocks.fetch.mockResolvedValue(new Response('{'))
		expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
			status: 'unavailable',
		})
	})
	it('bounds transport time and never retries', async () => {
		vi.useFakeTimers()
		mocks.fetch.mockImplementation(
			(_url, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')))
				}),
		)
		const result = readDrovrCertificateCompletion('test-contact')
		await vi.advanceTimersByTimeAsync(2100)
		expect(await result).toEqual({ status: 'unavailable' })
		expect(mocks.fetch).toHaveBeenCalledTimes(1)
	})
	it('treats transport failure as unavailable', async () => {
		mocks.fetch.mockRejectedValue(new Error('offline'))
		expect(await readDrovrCertificateCompletion('test-contact')).toEqual({
			status: 'unavailable',
		})
	})
})
