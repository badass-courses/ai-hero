import { describe, expect, it } from 'vitest'

import { getNavMode } from './nav-mode'

describe('getNavMode', () => {
	it('returns full for the homepage', () => {
		expect(getNavMode('/')).toBe('full')
		expect(getNavMode('')).toBe('full')
		expect(getNavMode(null)).toBe('full')
		expect(getNavMode(undefined)).toBe('full')
	})

	it('returns full for course/sales and commerce sections', () => {
		expect(getNavMode('/workshops')).toBe('full')
		expect(getNavMode('/workshops/ai-sdk-v6-crash-course')).toBe('full')
		expect(getNavMode('/cohorts')).toBe('full')
		expect(getNavMode('/cohorts/ai-coding-for-real-engineers-m0k0w')).toBe(
			'full',
		)
		expect(getNavMode('/events')).toBe('full')
		expect(getNavMode('/events/some-event')).toBe('full')
		expect(getNavMode('/products')).toBe('full')
		expect(getNavMode('/for-your-team')).toBe('full')
		expect(getNavMode('/courses')).toBe('full')
		expect(getNavMode('/courses/some-future-course')).toBe('full')
	})

	it('returns full for public legal/info pages', () => {
		expect(getNavMode('/faq')).toBe('full')
		expect(getNavMode('/privacy')).toBe('full')
	})

	it('returns hub for free-learning sections', () => {
		expect(getNavMode('/posts')).toBe('hub')
		expect(getNavMode('/skills')).toBe('hub')
		expect(getNavMode('/skills/grill-me')).toBe('hub')
		expect(getNavMode('/ai-coding-dictionary')).toBe('hub')
		expect(getNavMode('/ai-coding-dictionary/tokens')).toBe('hub')
	})

	it('returns hub for the new (not-yet-built) learning routes', () => {
		expect(getNavMode('/learn')).toBe('hub')
		expect(getNavMode('/tools')).toBe('hub')
		expect(getNavMode('/principles')).toBe('hub')
	})

	it('returns hub for top-level article slugs served by /[post]', () => {
		expect(getNavMode('/llm-fundamentals')).toBe('hub')
		expect(getNavMode('/ai-engineer-roadmap')).toBe('hub')
		expect(getNavMode('/vercel-ai-sdk-tutorial')).toBe('hub')
		expect(getNavMode('/what-is-an-llm')).toBe('hub')
	})

	it('returns minimal for editor and creation sub-routes', () => {
		expect(getNavMode('/posts/some-post/edit')).toBe('minimal')
		expect(getNavMode('/workshops/x/y/edit')).toBe('minimal')
		expect(getNavMode('/posts/new')).toBe('minimal')
		expect(getNavMode('/cohorts/new')).toBe('minimal')
		expect(getNavMode('/skills/grill-me/edit')).toBe('minimal')
	})

	it('returns minimal for admin, auth, account, and utility flows', () => {
		expect(getNavMode('/admin/dashboard')).toBe('minimal')
		expect(getNavMode('/login')).toBe('minimal')
		expect(getNavMode('/profile')).toBe('minimal')
		expect(getNavMode('/team')).toBe('minimal')
		expect(getNavMode('/settings/billing')).toBe('minimal')
		expect(getNavMode('/invoices/abc')).toBe('minimal')
		expect(getNavMode('/newsletter')).toBe('minimal')
		expect(getNavMode('/thanks/purchase')).toBe('minimal')
		expect(getNavMode('/q')).toBe('minimal')
		expect(getNavMode('/survey/nps')).toBe('minimal')
	})

	it('does not match a prefix that is only a string prefix, not a path segment', () => {
		// `/teamwork` must not be classified as the `/team` account route.
		expect(getNavMode('/teamwork')).toBe('hub') // single-segment article fallback
		// `/posts`-prefixed strings still need the segment boundary.
		expect(getNavMode('/posting-guide')).toBe('hub')
	})

	it('normalizes trailing slashes, casing, and query/hash', () => {
		expect(getNavMode('/Skills/')).toBe('hub')
		expect(getNavMode('/WORKSHOPS')).toBe('full')
		expect(getNavMode('/posts/?q=foo')).toBe('hub')
		expect(getNavMode('/login#section')).toBe('minimal')
	})

	it('falls back to full for unknown deeper paths', () => {
		expect(getNavMode('/some/deep/unknown/path')).toBe('full')
	})
})
