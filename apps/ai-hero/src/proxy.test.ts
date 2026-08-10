import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'

vi.mock('@/server/auth', () => ({
	auth: (middleware: unknown) => middleware,
}))

vi.mock('@/server/logger', () => ({
	log: { warn: vi.fn() },
}))

import { config } from './proxy'

const doesProxyMatch = (url: string) =>
	unstable_doesMiddlewareMatch({ config, url })

describe('proxy matcher', () => {
	it.each([
		'/admin',
		'/admin/dashboard',
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
