import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INTERNAL_COMP_CLAIM, withPrivateCompClaim } from './free-claim-request'
import { cohortCouponPresentation } from './cohort-presentation'
import { PRODUCT } from './namespace'

const path = 'https://example.test/api/coursebuilder/redeem/coupon'
const code = 'c5comp_' + 'a'.repeat(40)
const ordinary = { couponId: 'ordinary-free', productIds: [PRODUCT] }

beforeEach(() => {
	vi.stubEnv('AIH_COUPON_BATCH_ENABLED', '')
	delete process.env.AIH_COUPON_BATCH_ENABLED
})
afterEach(() => {
	vi.unstubAllEnvs()
})

it.each([
	['absent', new TextEncoder().encode(JSON.stringify(ordinary)), undefined],
	['implicit text/plain', JSON.stringify(ordinary), undefined],
	['real client JSON', JSON.stringify(ordinary), 'application/json'],
	[
		'JSON with charset',
		JSON.stringify(ordinary),
		'application/json; charset=utf-8',
	],
	[
		'legacy form',
		new URLSearchParams({ couponId: ordinary.couponId }),
		undefined,
	],
	['malformed ordinary JSON', '{broken', 'application/json'],
] as const)(
	'passes ordinary flag-off redeem unchanged: %s',
	async (_, body, contentType) => {
		const request = new Request(path, {
			method: 'POST',
			body,
			headers: contentType ? { 'content-type': contentType } : {},
		})
		const response = new Response(null)
		const dispatch = vi.fn(async (received: Request) => {
			expect(received).toBe(request)
			expect(received.bodyUsed).toBe(false)
			return response
		})
		expect(await withPrivateCompClaim(request, dispatch)).toBe(response)
		expect(dispatch).toHaveBeenCalledOnce()
	},
)

it('does not resolve even a reserved cohort selector while the flag is unset', async () => {
	const adapter = { getCoupon: vi.fn() }
	for (const queryCode of [
		undefined,
		'ordinary-free',
		'legacy-promotion',
		code,
	])
		expect(
			await cohortCouponPresentation(
				adapter,
				undefined as never,
				PRODUCT,
				queryCode,
			),
		).toBe(adapter)
	expect(adapter.getCoupon).not.toHaveBeenCalled()
})

it.each([
	() => {
		const form = new FormData()
		form.set('couponId', code)
		return form
	},
	() => new URLSearchParams({ couponId: code, productIds: PRODUCT }),
])(
	'refuses non-JSON comp claims without dispatching or echoing the selector',
	async (form) => {
		const dispatch = vi.fn(async () => new Response(null))
		const response = await withPrivateCompClaim(
			new Request(path, { method: 'POST', body: form() }),
			dispatch,
		)
		expect(response.status).toBe(415)
		expect(await response.text()).not.toContain(code)
		expect(dispatch).not.toHaveBeenCalled()
	},
)

it.each(['application/json', 'Application/JSON; charset=utf-8'])(
	'accepts comp claims sent as %s and preserves the productId array',
	async (mediaType) => {
		const dispatch = vi.fn(async (request: Request) => {
			expect(request.headers.get('content-type')).toBe('application/json')
			expect(await request.json()).toEqual({
				...ordinary,
				couponId: INTERNAL_COMP_CLAIM,
			})
			return new Response(null)
		})
		await withPrivateCompClaim(
			new Request(path, {
				method: 'POST',
				headers: { 'content-type': mediaType },
				body: JSON.stringify({ ...ordinary, couponId: code }),
			}),
			dispatch,
		)
		expect(dispatch).toHaveBeenCalledOnce()
	},
)
