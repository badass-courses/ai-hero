import { NextRequest, type NextResponse } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/auth', () => ({
	auth: (middleware: (...args: any[]) => unknown) => {
		return (...args: unknown[]) => middleware(...args)
	},
}))

vi.mock('@/server/logger', () => ({
	log: { warn: vi.fn() },
}))

import { EARLY_BIRD_CODE_COOKIE } from './lib/c5-pricing/early-bird-code'
import proxy, { rememberEarlyBirdCode } from './proxy'

const runProxy = proxy as unknown as (
	request: NextRequest,
) => Promise<NextResponse>

const C5 = 'https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m'

describe('proxy remembers an early-bird code', () => {
	it('stores a well-formed coupon id from the C5 page, httpOnly', async () => {
		const response = await runProxy(new NextRequest(`${C5}?coupon=coupon_h8hfc`))
		const cookie = response.headers.get('set-cookie') ?? ''
		expect(cookie).toContain(`${EARLY_BIRD_CODE_COOKIE}=coupon_h8hfc`)
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('Path=/')
	})

	it('stores it for a signed-in visitor too', async () => {
		const request = new NextRequest(`${C5}?coupon=coupon_h8hfc`, {
			headers: { cookie: 'authjs.session-token=x' },
		})
		const response = await runProxy(request)
		expect(response.headers.get('set-cookie') ?? '').toContain(
			`${EARLY_BIRD_CODE_COOKIE}=coupon_h8hfc`,
		)
	})

	it('sets it on a plain or redirect Response, as Auth.js may return', () => {
		const req = new NextRequest(`${C5}?coupon=coupon_h8hfc`)
		for (const response of [
			new Response('ok'),
			Response.redirect('https://www.aihero.dev/organization-list', 307),
		]) {
			const out = rememberEarlyBirdCode(req, response)
			expect(out.headers.get('set-cookie')).toMatch(
				/^c5_early_bird_code=coupon_h8hfc; Path=\/; Max-Age=1209600; HttpOnly; SameSite=Lax/,
			)
		}
	})

	it('ignores other pages and malformed ids', async () => {
		for (const url of [
			`${C5}`,
			`${C5}?coupon=not-a-coupon`,
			'https://www.aihero.dev/cohorts/some-other-cohort?coupon=coupon_h8hfc',
		]) {
			const response = await runProxy(new NextRequest(url))
			expect(response.headers.get('set-cookie') ?? '').not.toContain(
				EARLY_BIRD_CODE_COOKIE,
			)
		}
	})
})
