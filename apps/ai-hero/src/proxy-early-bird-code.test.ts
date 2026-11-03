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
import proxy from './proxy'

const runProxy = proxy as unknown as (
	request: NextRequest,
) => Promise<NextResponse>

const C5 = 'https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m'

describe('proxy remembers an early-bird code', () => {
	it('stores a well-formed coupon id from the C5 page, httpOnly', async () => {
		const response = await runProxy(new NextRequest(`${C5}?coupon=coupon_h8hfc`))
		const cookie = response.cookies.get(EARLY_BIRD_CODE_COOKIE)
		expect(cookie?.value).toBe('coupon_h8hfc')
		expect(cookie?.httpOnly).toBe(true)
		expect(cookie?.path).toBe('/')
	})

	it('stores it for a signed-in visitor too', async () => {
		const request = new NextRequest(`${C5}?coupon=coupon_h8hfc`, {
			headers: { cookie: 'authjs.session-token=x' },
		})
		const response = await runProxy(request)
		expect(response.cookies.get(EARLY_BIRD_CODE_COOKIE)?.value).toBe(
			'coupon_h8hfc',
		)
	})

	it('ignores other pages and malformed ids', async () => {
		for (const url of [
			`${C5}`,
			`${C5}?coupon=not-a-coupon`,
			'https://www.aihero.dev/cohorts/some-other-cohort?coupon=coupon_h8hfc',
		]) {
			const response = await runProxy(new NextRequest(url))
			expect(response.cookies.get(EARLY_BIRD_CODE_COOKIE)).toBeUndefined()
		}
	})
})
