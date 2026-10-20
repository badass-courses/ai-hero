import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest, type NextResponse } from 'next/server'

const authSpy = vi.hoisted(() => vi.fn())

vi.mock('@/server/auth', () => ({
	auth: (middleware: (...args: any[]) => unknown) => {
		return (...args: unknown[]) => {
			authSpy()
			return middleware(...args)
		}
	},
}))

vi.mock('@/server/logger', () => ({
	log: { warn: vi.fn() },
}))

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

import proxy, { config, hasSessionCookie, SESSION_COOKIE_PREFIXES } from './proxy'

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

describe('roleless organization routing', () => {
	const rolelessRequest = (path: string) =>
		Object.assign(
			new NextRequest(`https://www.aihero.dev${path}`, {
				headers: { cookie: 'authjs.session-token=abc' },
			}),
			{
				auth: { user: { id: 'buyer', roles: [], organizationRoles: [] } },
			},
		)

	it('lets a roleless buyer load the organization list instead of redirecting to itself', async () => {
		const response = await runProxy(
			rolelessRequest('/organization-list#my-courses'),
		)

		expect(response.headers.get('x-middleware-next')).toBe('1')
		expect(response.headers.get('location')).toBeNull()
	})

	it.each(['/invoices/mc_synthetic'])(
		'leaves single invoice authorization to the page for %s',
		async (path) => {
			const response = await runProxy(rolelessRequest(path))
			expect(response.headers.get('x-middleware-next')).toBe('1')
			expect(response.headers.get('location')).toBeNull()
		},
	)

	it('returns 404 for a malformed escape in an invoice path', async () => {
		const response = await runProxy(rolelessRequest('/invoices/%E0%A4%A'))
		expect(response.status).toBe(404)
		expect(response.headers.get('location')).toBeNull()
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(response.headers.get('cache-control')).toBe('private, no-store')
	})
	it('removes an invalid query token before organization routing or rendering', async () => {
		const response = await runProxy(
			rolelessRequest('/invoices/mc_synthetic?t=garbage'),
		)
		expect(response.status).toBe(307)
		expect(response.headers.get('location')).toBe(
			'https://www.aihero.dev/invoices/mc_synthetic',
		)
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(response.headers.get('cache-control')).toBe('private, no-store')
	})

	it('still sends a roleless buyer from the team page to the organization list', async () => {
		const response = await runProxy(rolelessRequest('/team'))

		expect(response.status).toBe(307)
		expect(response.headers.get('location')).toBe(
			'https://www.aihero.dev/organization-list',
		)
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
		expect(response.headers.get('x-middleware-rewrite')).toContain('/not-found')
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

describe('session lookup avoidance', () => {
	beforeEach(() => authSpy.mockClear())

	it.each([
		'/rss.xml',
		'/llms.txt',
		'/sitemap.md',
		'/skills.md',
		'/c/ai-coding/real-codebase-risk',
	])('answers %s without invoking auth()', async (path) => {
		const req = new NextRequest(`https://www.aihero.dev${path}`, {
			headers: { cookie: 'authjs.session-token=abc' },
		})
		await runProxy(req)
		expect(authSpy).not.toHaveBeenCalled()
	})

	it('skips auth() on /cohorts without a session cookie', async () => {
		const res = await runProxy(
			new NextRequest('https://www.aihero.dev/cohorts/ai-coding'),
		)
		expect(res.status).toBe(200)
		expect(authSpy).not.toHaveBeenCalled()
	})

	it.each(['authjs.session-token', '__Secure-authjs.session-token.0'])(
		'still invokes auth() on /cohorts with %s',
		async (name) => {
			await runProxy(
				new NextRequest('https://www.aihero.dev/cohorts/ai-coding', {
					headers: { cookie: `${name}=abc` },
				}),
			)
			expect(authSpy).toHaveBeenCalledTimes(1)
		},
	)

	it.each(['/admin/dashboard', '/invoices/charge-123'])(
		'always invokes auth() on %s',
		async (path) => {
			await runProxy(new NextRequest(`https://www.aihero.dev${path}`))
			expect(authSpy).toHaveBeenCalledTimes(1)
		},
	)
})

// `@auth/core` does not export its cookie internals, so load the pinned file
// next to its public entry point.
const loadSessionStore = async () => {
	const entry = createRequire(import.meta.url).resolve('@auth/core')
	const mod = await import(
		pathToFileURL(path.join(path.dirname(entry), 'lib/utils/cookie.js')).href
	)
	return mod.SessionStore as new (
		option: unknown,
		cookies: Record<string, string>,
		logger: unknown,
	) => { value: string }
}

describe('hasSessionCookie matches Auth.js SessionStore', () => {
	const names = SESSION_COOKIE_PREFIXES.flatMap((prefix) => [
		prefix,
		`${prefix}.0`,
		`${prefix}.12`,
		`${prefix}.extra`,
		`${prefix}-old`,
		`${prefix}x`,
	])
	const logger = { debug() {}, error() {}, warn() {} } as never

	it.each(SESSION_COOKIE_PREFIXES)(
		'treats every cookie SessionStore reads for %s as a session',
		async (prefix) => {
			const SessionStore = await loadSessionStore()
			for (const name of names.filter((n) => n.startsWith(prefix))) {
				const store = new SessionStore(
					{ name: prefix, options: {} },
					{ [name]: 'abc' },
					logger,
				)
				expect(store.value).toBe('abc')
				const req = new NextRequest('https://www.aihero.dev/cohorts/x', {
					headers: { cookie: `${name}=abc` },
				})
				expect(hasSessionCookie(req)).toBe(true)
			}
		},
	)

	it('is false for unrelated cookies', () => {
		const req = new NextRequest('https://www.aihero.dev/cohorts/x', {
			headers: { cookie: 'organizationId=1; authjs.csrf-token=x' },
		})
		expect(hasSessionCookie(req)).toBe(false)
	})
})
