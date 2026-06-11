import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getShortlinkBySlug: vi.fn(),
	recordClick: vi.fn(),
	log: {
		error: vi.fn(),
	},
}))

vi.mock('@/lib/shortlinks-query', () => ({
	getShortlinkBySlug: mocks.getShortlinkBySlug,
	recordClick: mocks.recordClick,
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
}))

import { GET, buildShortlinkRedirectUrl } from './route'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.recordClick.mockResolvedValue(undefined)
})

describe('buildShortlinkRedirectUrl', () => {
	it('preserves allowlisted paid attribution params and drops arbitrary params', () => {
		const url = buildShortlinkRedirectUrl(
			'https://www.aihero.dev/_campaign/ai-coding/claude-code-workflows?utm_source=google&utm_medium=cpc&utm_campaign=c004_search_smoke_test&utm_content=manifest_value',
			'https://www.aihero.dev/s/ads-c004-claude-workflows?gclid=TEST_CLICK&utm_content=ad_override&utm_term=claude+code&debug_secret=nope',
		)

		expect(url.origin).toBe('https://www.aihero.dev')
		expect(url.pathname).toBe('/_campaign/ai-coding/claude-code-workflows')
		expect(url.searchParams.get('utm_source')).toBe('google')
		expect(url.searchParams.get('utm_medium')).toBe('cpc')
		expect(url.searchParams.get('utm_campaign')).toBe('c004_search_smoke_test')
		expect(url.searchParams.get('utm_content')).toBe('ad_override')
		expect(url.searchParams.get('utm_term')).toBe('claude code')
		expect(url.searchParams.get('gclid')).toBe('TEST_CLICK')
		expect(url.searchParams.get('debug_secret')).toBeNull()
	})

	it('keeps destination params when no incoming attribution override exists', () => {
		const url = buildShortlinkRedirectUrl(
			'https://www.aihero.dev/cohorts/ai-coding-for-real-engineers-m0k0w?utm_source=google&utm_medium=cpc&utm_campaign=c004_brand_defense&utm_content=brand_ai_hero',
			'https://www.aihero.dev/s/ads-c004-brand-ai-hero?debug_secret=nope',
		)

		expect(url.searchParams.get('utm_content')).toBe('brand_ai_hero')
		expect(url.searchParams.get('debug_secret')).toBeNull()
	})
})

describe('/s/[slug] redirect', () => {
	it('redirects with preserved paid click evidence and sets sl_ref', async () => {
		mocks.getShortlinkBySlug.mockResolvedValue({
			url: 'https://www.aihero.dev/_campaign/ai-coding/claude-code-workflows?utm_source=google&utm_medium=cpc&utm_campaign=c004_search_smoke_test&utm_content=manifest_value',
		})

		const response = await GET(
			new NextRequest(
				'https://www.aihero.dev/s/ads-c004-claude-workflows?gclid=TEST_CLICK&utm_content=ad_override&junk=nope',
			),
			{ params: Promise.resolve({ slug: 'ads-c004-claude-workflows' }) },
		)

		expect(response.status).toBe(307)
		const location = new URL(response.headers.get('location') ?? '')
		expect(location.origin).toBe('https://www.aihero.dev')
		expect(location.pathname).toBe('/_campaign/ai-coding/claude-code-workflows')
		expect(location.searchParams.get('utm_content')).toBe('ad_override')
		expect(location.searchParams.get('gclid')).toBe('TEST_CLICK')
		expect(location.searchParams.get('junk')).toBeNull()
		expect(response.cookies.get('sl_ref')?.value).toBe(
			'ads-c004-claude-workflows',
		)
		expect(mocks.recordClick).toHaveBeenCalledWith(
			'ads-c004-claude-workflows',
			expect.objectContaining({ referrer: null }),
		)
	})
})
