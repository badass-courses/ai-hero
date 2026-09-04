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
		'/rss.xml',
		'/skills/rss.xml',
		'/sitemap.md',
		'/llms.txt',
		'/md/skills',
		'/md/workshops/agentic-coding/lesson-one',
		'/skills.md',
		'/workshops/agentic-coding/lesson-one.md',
	])('includes %s', (url) => {
		expect(doesProxyMatch(url)).toBe(true)
	})

	it.each([
		'/',
		'/a-public-post',
		'/skills%E2%80%94discussed',
		'/grill-with-doc%EE%80%80s',
		'/lists',
		'/lists/ai-coding',
		'/sitemap.xml',
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

describe('static route handler OPTIONS', () => {
	it.each(['/skills.md', '/md/skills', '/rss.xml', '/sitemap.md'])(
		'answers OPTIONS %s at the edge with 200 instead of a 204',
		async (path) => {
			const response = await runProxy(
				new NextRequest(`https://www.aihero.dev${path}?_rsc=abc`, {
					method: 'OPTIONS',
				}),
			)

			expect(response.status).toBe(200)
			expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
			expect(response.headers.get('x-middleware-next')).toBeNull()
		},
	)

	it('passes GET through untouched', async () => {
		const response = await runProxy(
			new NextRequest('https://www.aihero.dev/skills.md'),
		)

		expect(response.headers.get('x-middleware-next')).toBe('1')
		expect(response.headers.get('x-middleware-rewrite')).toBeNull()
	})

	it('does not intercept OPTIONS on other paths', async () => {
		const response = await runProxy(
			new NextRequest('https://www.aihero.dev/admin', { method: 'OPTIONS' }),
		)

		expect(response.headers.get('allow')).toBeNull()
		expect(response.headers.get('x-middleware-rewrite')).toContain(
			'/not-found',
		)
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
