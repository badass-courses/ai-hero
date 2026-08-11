import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest, type NextResponse } from 'next/server'

vi.mock('@/server/auth', () => ({
	auth: (middleware: unknown) => middleware,
}))

vi.mock('@/server/logger', () => ({
	log: { warn: vi.fn() },
}))

import proxy, { config } from './proxy'

const doesProxyMatch = (url: string) =>
	unstable_doesMiddlewareMatch({ config, url })

const runProxy = proxy as unknown as (
	request: NextRequest,
) => Promise<NextResponse>

describe('proxy matcher', () => {
	it.each([
		'/admin',
		'/admin/dashboard',
		'/?code=x',
		'/?coupon=y',
		'/c/ai-coding/real-codebase-risk',
		'/subscribe/logged-in',
		'/products/cohort',
		'/organization-list',
		'/settings/billing',
		'/cohorts/ai-coding',
		'/events/ai-hero-live',
		'/invoices',
		'/invoices/charge-123',
		'/team',
		'/profile',
		'/profile/user-123',
		'/thanks/purchase',
		'/transfer/purchase-123',
		'/welcome',
	])('includes %s', (url) => {
		expect(doesProxyMatch(url)).toBe(true)
	})

	it.each([
		'/',
		'/a-public-post',
		'/lists',
		'/lists/ai-coding',
		'/rss.xml',
		'/skills/rss.xml',
		'/ai-coding-dictionary',
		'/ai-coding-dictionary/agent',
		'/q',
		'/courses',
		'/workshops',
		'/workshops/agentic-coding/lesson-one',
		'/api/trpc/cohorts.get',
		'/_next/static/chunks/app.js',
		'/favicon.ico',
		'/robots.txt',
	])('excludes %s', (url) => {
		expect(doesProxyMatch(url)).toBe(false)
	})
})

describe('homepage coupon rewrite', () => {
	it.each([
		['code', 'golden-code'],
		['coupon', 'golden-coupon'],
	])('rewrites %s and preserves the full query', async (key, value) => {
		const response = await runProxy(
			new NextRequest(
				`https://www.aihero.dev/?${key}=${value}&utm_source=share`,
				{
					headers: {
						host: 'localhost:3000',
						'x-forwarded-proto': 'http',
					},
				},
			),
		)

		expect(response.headers.get('x-middleware-rewrite')).toBe(
			`http://localhost:3000/home-coupon?${key}=${value}&utm_source=share`,
		)
	})
})
