import {
	DISCOVERY_CACHE_CONTROL,
	getPublicDiscoveryResources,
} from '@/lib/agent-discovery'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET as getApiCatalog } from '../../.well-known/api-catalog/route'
import { GET as getLlmsTxt } from '../../llms.txt/route'
import { GET as getHomepageMarkdown } from '../../md/home/route'
import { GET as getSitemapMarkdown } from '../../sitemap.md/route'
import { GET as getOpenApi } from '../openapi.json/route'
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
				apiCatalog: '/.well-known/api-catalog',
				openapi: '/api/openapi.json',
				courseSyncOpenapi: '/v1/course-sync/openapi.json',
				sitemap: '/sitemap.xml',
				sitemapMarkdown: '/sitemap.md',
				llms: '/llms.txt',
			},
			agentTokens: {
				presentation: {
					header: 'Authorization: Bearer AGENT_TOKEN',
				},
				privilegedRead: {
					scope: 'content:read',
				},
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
					name: 'course-sync-openapi',
					api: '/v1/course-sync/openapi.json',
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
		expect(payload.agentTokens.scopes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'content:read', status: 'active' }),
				expect.objectContaining({ name: 'analytics:read', status: 'reserved' }),
			]),
		)
		expect(payload.agentTokens.management.curl.mint).toContain(
			'Authorization: Bearer ADMIN_DEVICE_TOKEN',
		)
		expect(payload.agentTokens.privilegedRead.includes).toContain('draft')
		expect(payload.agentTokens.privilegedRead.excludes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ capability: 'Raw video and Mux payloads' }),
				expect.objectContaining({ capability: 'Legacy signed upload URLs' }),
			]),
		)
		expect(payload.agentTokens.errors['401']).toContain('expired')
		expect(payload.agentTokens.errors['403']).toContain('valid')
		expect(payload.nextActions.length).toBeLessThanOrEqual(5)
	})

	it('GET /api/openapi.json documents bearer auth, content scope edges, and token management', async () => {
		const response = await getOpenApi()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'application/json; charset=utf-8',
		)
		expect(response.headers.get('Cache-Control')).toBe(DISCOVERY_CACHE_CONTROL)

		const document = await response.json()
		expect(document).toMatchObject({
			openapi: '3.1.0',
			servers: [{ url: 'http://localhost:3000' }],
			components: {
				securitySchemes: {
					bearerAuth: {
						type: 'http',
						scheme: 'bearer',
					},
				},
			},
		})
		expect(
			document.components.securitySchemes.bearerAuth.description,
		).toContain('aih_pat_*')
		expect(
			document.components.securitySchemes.bearerAuth.description,
		).toContain('role-derived device tokens')

		const contentOperationCount = Object.entries(document.paths)
			.filter(([path]) => !path.startsWith('/api/personal-access-tokens'))
			.flatMap(([, pathItem]) =>
				Object.keys(pathItem as Record<string, unknown>).filter((key) =>
					['get', 'post', 'put', 'patch', 'delete', 'options'].includes(key),
				),
			).length
		expect(contentOperationCount).toBe(56)
		// List membership is a relations write: content:read must see it as
		// excluded, while a content:relations PAT (or update Content) may act.
		expect(document.paths['/api/lists/{listId}/resources'].post).toMatchObject({
			security: [{ bearerAuth: [] }],
			'x-required-scopes': ['content:relations'],
			'x-required-ability': 'update Content',
		})
		expect(document.paths['/api/posts'].get).toMatchObject({
			security: [{ bearerAuth: [] }],
			'x-required-scopes': ['content:read'],
		})
		expect(document.paths['/api/posts'].post).toMatchObject({
			security: [{ bearerAuth: [] }],
			'x-required-scopes': ['content:write', 'content:relations'],
			'x-scope-requirements': expect.stringContaining(
				'content:write is required',
			),
			'x-required-ability': 'create Content',
		})
		expect(document.paths['/api/search'].get.security).toEqual([
			{},
			{ bearerAuth: [] },
		])
		expect(document.paths['/api/search'].get.responses).not.toHaveProperty(
			'401',
		)
		expect(document.paths['/api/search'].get.responses).not.toHaveProperty(
			'403',
		)
		expect(document.paths).not.toHaveProperty('/api/memory')
		expect(document.paths).not.toHaveProperty('/api/surveys')
		expect(document.paths).not.toHaveProperty(
			'/api/products/{productId}/enrollment',
		)
		expect(document.paths['/api/shortlinks'].get).toMatchObject({
			'x-required-scopes': ['shortlinks:manage'],
			'x-required-ability': 'manage all',
			'x-agent-token-policy': expect.stringContaining('shortlinks:manage'),
		})
		expect(document.paths['/api/tags'].get.security).toEqual([])
		expect(
			document.paths['/api/pages'].put.requestBody.content['application/json']
				.schema,
		).toEqual({ $ref: '#/components/schemas/UpdatePageRequest' })
		expect(
			document.paths['/api/skills/changelog'].post.responses['201'].content[
				'application/json'
			].schema,
		).toEqual({ $ref: '#/components/schemas/SkillChangelogSuccessResponse' })
		expect(
			document.components.schemas.SkillChangelogSuccessResponse.allOf[0],
		).toEqual({ $ref: '#/components/schemas/CommandSuccessEnvelope' })
		expect(
			document.components.schemas.SkillChangelogSuccessResponse.allOf[1]
				.properties,
		).toMatchObject({
			id: { type: 'string', deprecated: true },
			slug: { type: 'string', deprecated: true },
		})

		const tokenCollection = document.paths['/api/personal-access-tokens']
		expect(
			tokenCollection.post.requestBody.content['application/json'].schema,
		).toEqual({ $ref: '#/components/schemas/MintPersonalAccessTokenRequest' })
		expect(tokenCollection.post.responses['201'].description).toContain(
			'returned once',
		)
		const mintResponseSchema =
			document.components.schemas.MintPersonalAccessTokenResponse
		expect(mintResponseSchema).toMatchObject({
			type: 'object',
			additionalProperties: false,
			required: expect.arrayContaining(['token', 'id', 'scopes']),
			properties: {
				token: expect.objectContaining({
					// zod-to-json-schema escapes underscores in startsWith patterns
					pattern: '^aih\\_pat\\_',
				}),
			},
		})
		expect(mintResponseSchema).not.toHaveProperty('allOf')
		expect(tokenCollection.post.responses).toEqual(
			expect.objectContaining({
				'400': expect.any(Object),
				'401': expect.any(Object),
				'403': expect.any(Object),
				'503': expect.any(Object),
			}),
		)
		expect(
			tokenCollection.get.responses['200'].content['application/json'].schema,
		).toMatchObject({ type: 'array' })
		expect(
			document.paths['/api/personal-access-tokens/{id}'].delete.responses['200']
				.content['application/json'].schema,
		).toEqual({ $ref: '#/components/schemas/PersonalAccessToken' })
	})

	it('GET /.well-known/api-catalog returns the standard API linkset', async () => {
		const response = await getApiCatalog()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'application/linkset+json',
		)
		expect(response.headers.get('Cache-Control')).toBe(DISCOVERY_CACHE_CONTROL)

		const payload = await response.json()
		expect(payload).toEqual({
			linkset: [
				{
					anchor: 'http://localhost:3000/',
					'service-desc': [
						{
							href: 'http://localhost:3000/api/openapi.json',
							type: 'application/openapi+json',
						},
						{
							href: 'http://localhost:3000/v1/course-sync/openapi.json',
							type: 'application/openapi+json',
						},
					],
					'service-doc': [
						{
							href: 'http://localhost:3000/llms.txt',
							type: 'text/plain',
						},
					],
				},
			],
		})
	})

	it('serves a markdown projection for negotiated homepage requests', async () => {
		const response = await getHomepageMarkdown()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/markdown; charset=utf-8',
		)
		expect(response.headers.get('Cache-Control')).toBe(DISCOVERY_CACHE_CONTROL)

		const body = await response.text()
		expect(body).toContain('# AI Hero')
		expect(body).toContain('http://localhost:3000/.well-known/api-catalog')
		expect(body).toContain('http://localhost:3000/api/openapi.json')
		expect(body).toContain('http://localhost:3000/v1/course-sync/openapi.json')
		expect(body).toContain('http://localhost:3000/llms.txt')
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
		expect(body).toContain('Agent tokens:')
		expect(body).toContain('http://localhost:3000/api/openapi.json')
		expect(body).toContain('http://localhost:3000/.well-known/api-catalog')
		expect(body).toContain('http://localhost:3000/v1/course-sync/openapi.json')
		expect(body).toContain('Authorization: Bearer ADMIN_DEVICE_TOKEN')
		expect(body).toContain('content:read')
		expect(body).toContain('draft, unpublished, private, and unlisted')
		expect(body).toContain('raw Mux/video payloads')
		expect(body).toContain('401 usually means')
		expect(body).toContain('403 means')
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
