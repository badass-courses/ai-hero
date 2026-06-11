import {
	DISCOVERY_CACHE_CONTROL,
	getPublicDiscoveryResources,
} from '@/lib/agent-discovery'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET as getLlmsTxt } from '../../llms.txt/route'
import { GET as getSitemapMarkdown } from '../../sitemap.md/route'
import { GET as getApiDiscovery } from '../route'

vi.mock('@/lib/agent-discovery', async () => {
	const actual = await vi.importActual<typeof import('@/lib/agent-discovery')>(
		'@/lib/agent-discovery',
	)

	return {
		...actual,
		getPublicDiscoveryResources: vi.fn().mockResolvedValue([
			{
				title: 'Intro to AI Hero',
				url: 'http://localhost:3000/intro-to-ai-hero',
				type: 'post',
			},
			{
				title: 'Free Workshop Lesson',
				url: 'http://localhost:3000/workshops/agentic-coding/intro',
				type: 'lesson',
			},
		]),
	}
})

const mockedGetPublicDiscoveryResources = vi.mocked(getPublicDiscoveryResources)

afterEach(() => {
	vi.clearAllMocks()
})

describe('AI Hero discovery surfaces', () => {
	it('GET /api returns a stable JSON discovery document', async () => {
		const response = await getApiDiscovery()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'application/json; charset=utf-8',
		)
		expect(response.headers.get('Cache-Control')).toBe(DISCOVERY_CACHE_CONTROL)
		expect(mockedGetPublicDiscoveryResources).not.toHaveBeenCalled()

		const payload = await response.json()
		expect(payload).toMatchObject({
			version: 1,
			name: 'AI Hero Public API Discovery',
			baseUrl: 'http://localhost:3000',
			formats: {
				html: 'text/html',
				markdown: 'text/markdown',
				json: 'application/json',
			},
			discovery: {
				api: '/api',
				sitemap: '/sitemap.xml',
				sitemapMarkdown: '/sitemap.md',
				llms: '/llms.txt',
			},
		})
		expect(payload.resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'posts-and-lists',
					htmlPattern: '/:slug',
					markdownPattern: '/:slug.md',
					visibility: 'public',
				}),
				expect.objectContaining({
					name: 'products',
					htmlPattern: '/products/:slug',
					markdownPattern: '/products/:slug.md',
					visibility: 'public',
				}),
				expect.objectContaining({
					name: 'search',
					api: '/api/search?q=:query',
					visibility: 'public',
				}),
			]),
		)
		expect(JSON.stringify(payload.resources)).not.toContain('/md/')
		expect(JSON.stringify(payload)).not.toContain('(content)')
		expect(JSON.stringify(payload)).not.toContain('app/')
		expect(payload.nextActions).toEqual(
			expect.arrayContaining([
				'Read /sitemap.md for a markdown-oriented discovery index.',
				'Read /llms.txt for a short operator-oriented summary.',
				'Use explicit .md twins for low-token public content retrieval.',
			]),
		)
		expect(payload.nextActions.length).toBeLessThanOrEqual(4)
	})

	it('GET /llms.txt returns a lightweight plain-text hint surface', async () => {
		const response = await getLlmsTxt()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/plain; charset=utf-8',
		)
		expect(response.headers.get('Cache-Control')).toBe(DISCOVERY_CACHE_CONTROL)
		expect(mockedGetPublicDiscoveryResources).not.toHaveBeenCalled()

		const body = await response.text()
		expect(body).toContain('AI Hero public discovery')
		expect(body).toContain('Base URL: http://localhost:3000')
		expect(body).toContain('http://localhost:3000/api')
		expect(body).toContain('http://localhost:3000/sitemap.md')
		expect(body).toContain('http://localhost:3000/sitemap.xml')
		expect(body).toContain('http://localhost:3000/<slug>')
		expect(body).toContain('http://localhost:3000/<slug>.md')
		expect(body).toContain('http://localhost:3000/workshops/<module>.md')
		expect(body).toContain('http://localhost:3000/products/<slug>.md')
		expect(body).toContain('http://localhost:3000/cohorts/<slug>.md')
		expect(body).toContain('http://localhost:3000/events/<slug>.md')
		expect(body).toContain('http://localhost:3000/api/search?q=<query>')
		expect(body).toContain(
			'http://localhost:3000/api/resources?slugOrId=<slug>&type=<type>',
		)
		expect(body).not.toContain('Intro to AI Hero')
		expect(body).not.toContain('# AI Hero Public Discovery')
		expect(body).not.toContain('/md/')
		expect(body).not.toContain('(content)')
	})

	it('GET /sitemap.md returns markdown discovery content with corrected examples', async () => {
		const response = await getSitemapMarkdown()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		expect(response.headers.get('Cache-Control')).toBe(DISCOVERY_CACHE_CONTROL)

		const body = await response.text()
		expect(mockedGetPublicDiscoveryResources).toHaveBeenCalledTimes(1)
		expect(body).toContain('# AI Hero Public Discovery')
		expect(body).toContain('Version: 1')
		expect(body).toContain('http://localhost:3000/api')
		expect(body).toContain('http://localhost:3000/llms.txt')
		expect(body).toContain('http://localhost:3000/sitemap.xml')
		expect(body).toContain('## Human URLs')
		expect(body).toContain('http://localhost:3000/<slug>')
		expect(body).toContain('Intro to AI Hero')
		expect(body).toContain('Free Workshop Lesson')
		expect(body).toContain('## Markdown twins')
		expect(body).toContain('http://localhost:3000/<slug>.md')
		expect(body).toContain('http://localhost:3000/workshops/<module>.md')
		expect(body).toContain('http://localhost:3000/products/<slug>.md')
		expect(body).toContain('http://localhost:3000/cohorts/<slug>.md')
		expect(body).toContain('http://localhost:3000/events/<slug>.md')
		expect(body).toContain('http://localhost:3000/api/search?q=<query>')
		expect(body).toContain(
			'http://localhost:3000/api/resources?slugOrId=<slug>&type=<type>',
		)
		expect(body).toContain('curl http://localhost:3000/some-post-slug.md')
		expect(body).toContain(
			'curl http://localhost:3000/products/product-slug.md',
		)
		expect(body).toContain(
			"curl -H 'Accept: text/markdown' http://localhost:3000/some-post-slug",
		)
		expect(body).not.toContain('Updated:')
		expect(body).not.toContain('/https://')
		expect(body).not.toContain('/http://localhost:3000')
		expect(body).not.toContain('/md/')
		expect(body).not.toContain('(content)')
	})
})
