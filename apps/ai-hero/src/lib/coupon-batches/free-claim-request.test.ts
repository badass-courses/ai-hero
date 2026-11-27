import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
	activeCompClaimDigest,
	INTERNAL_COMP_CLAIM,
	withPrivateCompClaim,
} from './free-claim-request'
import { COMP_REDEEM_COOKIE } from './browser-claim'
import { BROWSER_COMP_CLAIM } from './namespace'
import { selectorDigest } from './selector'
import { PRODUCT } from './namespace'

const path = 'https://example.test/api/coursebuilder/redeem/coupon'
const code = 'c5comp_' + 'a'.repeat(40)
const ordinary = {
	couponId: 'ordinary-free',
	productIds: [PRODUCT],
	email: 'c5comp_student@example.test',
}

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
		new URLSearchParams({ couponId: ordinary.couponId, email: ordinary.email }),
		undefined,
	],
	[
		'malformed ordinary JSON',
		'{"email":"c5comp_student@example.test",',
		'application/json',
	],
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

it('passes an unrelated flag-off query parameter unchanged', async () => {
	const request = new Request(
		`${path}?email=${encodeURIComponent(ordinary.email)}`,
		{ method: 'POST' },
	)
	expect(await withPrivateCompClaim(request, async (input) => input)).toBe(
		request,
	)
})

it.each(['coupon', 'code', 'couponId'])(
	'rejects a reserved redeem query selector in %s',
	async (key) => {
		const dispatch = vi.fn(async () => new Response(null))
		const response = await withPrivateCompClaim(
			new Request(`${path}?${key}=${code}`, {
				method: 'POST',
				body: JSON.stringify(ordinary),
				headers: { 'content-type': 'application/json' },
			}),
			dispatch,
		)
		expect(response.status).toBe(400)
		expect(await response.text()).not.toContain(code)
		expect(dispatch).not.toHaveBeenCalled()
	},
)

it('strips the comp cookie even on a non-POST redeem path', async () => {
	const request = new Request(path, {
		headers: { cookie: `${COMP_REDEEM_COOKIE}=${code}; other=value` },
	})
	await withPrivateCompClaim(request, async (forwarded) => {
		expect(forwarded.headers.get('cookie')).toBe('other=value')
		expect(forwarded.method).toBe('GET')
		expect(forwarded.body).toBeNull()
	})
})

it('strips the comp cookie from an ordinary claim without rewriting its body', async () => {
	const request = new Request(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			cookie: `${COMP_REDEEM_COOKIE}=${code}; authjs.session-token=dummy; ${COMP_REDEEM_COOKIE}=${code}`,
		},
		body: JSON.stringify(ordinary),
	})
	await withPrivateCompClaim(request, async (forwarded) => {
		expect(forwarded.headers.get('cookie')).toBe('authjs.session-token=dummy')
		expect(forwarded.headers.get('content-type')).toBe('application/json; charset=utf-8')
		expect(await forwarded.text()).toBe(JSON.stringify(ordinary))
		expect(activeCompClaimDigest()).toBeNull()
	})
})

it.each([
	() => {
		const form = new FormData()
		form.set('couponId', code)
		return form
	},
	() => new URLSearchParams({ couponId: code, productIds: PRODUCT }),
	() => new URLSearchParams({ couponId: BROWSER_COMP_CLAIM }),
	() => new URLSearchParams({ coupon: code }),
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

it('accepts a scoped cookie with same-origin or absent fetch metadata and removes it from dispatch', async () => {
	const dispatch = vi.fn(async (request: Request) => {
		expect(activeCompClaimDigest()).toBe(selectorDigest(code))
		expect(request.headers.get('cookie')).toBe('authjs.session-token=dummy')
		expect(await request.json()).toMatchObject({
			couponId: INTERNAL_COMP_CLAIM,
		})
		return new Response(null)
	})
	for (const [site, hasCookie, status] of [
		['cross-site', true, 400],
		['same-origin', false, 400],
		['same-origin', true, 200],
		[undefined, true, 200],
	] as const) {
		const headers = new Headers({
			'content-type': 'application/json',
		})
		if (site) headers.set('sec-fetch-site', site)
		if (hasCookie)
			headers.set(
				'cookie',
				`${COMP_REDEEM_COOKIE}=${encodeURIComponent(`/cohorts/c5~${code}`)}; authjs.session-token=dummy`,
			)
		const response = await withPrivateCompClaim(
			new Request(path, {
				method: 'POST',
				headers,
				body: JSON.stringify({ ...ordinary, couponId: BROWSER_COMP_CLAIM }),
			}),
			dispatch,
		)
		expect(response.status).toBe(status)
	}
	expect(dispatch).toHaveBeenCalledTimes(2)
	expect(activeCompClaimDigest()).toBeNull()
})

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
