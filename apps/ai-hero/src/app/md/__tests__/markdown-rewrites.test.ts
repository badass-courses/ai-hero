import { describe, expect, it } from 'vitest'

import {
	beforeFilesMarkdownRewrites,
	homepageDiscoveryHeaders,
	homepageDiscoveryLinkHeader,
	markdownLikeAcceptHeaderPattern,
	negotiatedMarkdownRewrites,
} from '../../../../markdown-route-config.mjs'

describe('markdown rewrite configuration', () => {
	it('adds explicit .md rewrites for existing markdown-supported routes', () => {
		expect(beforeFilesMarkdownRewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: '/:slug((?!sitemap).+).md',
					destination: '/md/:slug',
				}),
				expect.objectContaining({
					source: '/tutorials/:module/:lesson.md',
					destination: '/md/tutorials/:module/:lesson',
				}),
				expect.objectContaining({
					source: '/workshops/:module/:lesson.md',
					destination: '/md/workshops/:module/:lesson',
				}),
			]),
		)
	})

	it('negotiates homepage markdown through the dedicated projection', () => {
		expect(beforeFilesMarkdownRewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: '/',
					destination: '/md/home',
					has: [
						expect.objectContaining({
							type: 'header',
							key: 'accept',
							value: markdownLikeAcceptHeaderPattern,
						}),
					],
				}),
			]),
		)
	})

	it('preserves negotiated markdown rewrites for existing route families', () => {
		expect(beforeFilesMarkdownRewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source:
						'/:slug((?!api/|api$|md/|md$|llms\\.txt$|robots\\.txt$|rss\\.xml$|sitemap\\.md$|sitemap\\.xml$).+)',
					destination: '/md/:slug',
					has: [
						expect.objectContaining({
							type: 'header',
							key: 'accept',
							value: markdownLikeAcceptHeaderPattern,
						}),
					],
				}),
				expect.objectContaining({
					source: '/tutorials/:module/:lesson',
					destination: '/md/tutorials/:module/:lesson',
				}),
				expect.objectContaining({
					source: '/workshops/:module/:lesson',
					destination: '/md/workshops/:module/:lesson',
				}),
			]),
		)
	})

	it('adds explicit .md rewrites for products, cohorts, events, and workshops', () => {
		expect(beforeFilesMarkdownRewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: '/products/:slug.md',
					destination: '/md/products/:slug',
				}),
				expect.objectContaining({
					source: '/cohorts/:slug.md',
					destination: '/md/cohorts/:slug',
				}),
				expect.objectContaining({
					source: '/events/:slug.md',
					destination: '/md/events/:slug',
				}),
				expect.objectContaining({
					source: '/workshops/:module.md',
					destination: '/md/workshops/:module',
				}),
			]),
		)
	})

	it('catch-all rewrite regex excludes API routes', () => {
		const catchAll = negotiatedMarkdownRewrites.find((r) =>
			r.source.includes(':slug'),
		)
		// Extract the regex from the source pattern (everything inside the parens after :slug)
		const regexStr = catchAll?.source.match(/:slug\((.+)\)/)?.[1]
		const regex = new RegExp(`^(?:${regexStr})$`)

		// Must NOT match API paths
		expect(regex.test('api')).toBe(false)
		expect(regex.test('api/coursebuilder/subscribe-to-list/convertkit')).toBe(
			false,
		)
		expect(regex.test('api/auth/callback')).toBe(false)

		// Must still match content paths
		expect(regex.test('some-blog-post')).toBe(true)
		expect(regex.test('getting-started-with-ai')).toBe(true)
	})

	it('catch-all rewrite regex cannot re-match its own /md destination', () => {
		const catchAll = negotiatedMarkdownRewrites.find((r) =>
			r.source.includes(':slug'),
		)
		const regexStr = catchAll?.source.match(/:slug\((.+)\)/)?.[1]
		const regex = new RegExp(`^(?:${regexStr})$`)

		// Vercel's routing layer re-checks rewrites against the rewritten path
		// with the original Accept header, so matching md/* would loop
		// `/` -> `/md/home` -> `/md/md/home` and 404 every negotiated request.
		expect(regex.test('md')).toBe(false)
		expect(regex.test('md/home')).toBe(false)
		expect(regex.test('md/workshops/module/lesson')).toBe(false)

		// Paths that merely start with "md" but are not under /md still match
		expect(regex.test('mdx-for-beginners')).toBe(true)
	})

	it('keeps discovery documents ahead of broad markdown rewrites', () => {
		expect(beforeFilesMarkdownRewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: '/.well-known/:path*',
					destination: '/.well-known/:path*',
				}),
				expect.objectContaining({
					source: '/api/:path*',
					destination: '/api/:path*',
				}),
				expect.objectContaining({
					source: '/llms.txt',
					destination: '/llms.txt',
				}),
				expect.objectContaining({
					source: '/robots.txt',
					destination: '/robots.txt',
				}),
				expect.objectContaining({
					source: '/rss.xml',
					destination: '/rss.xml',
				}),
				expect.objectContaining({
					source: '/sitemap.xml',
					destination: '/sitemap.xml',
				}),
				expect.objectContaining({
					source: '/sitemap.md',
					destination: '/sitemap.md',
				}),
			]),
		)
	})

	it('adds agent-useful Link headers to the homepage', () => {
		expect(homepageDiscoveryHeaders).toEqual([
			{
				source: '/',
				headers: [
					{ key: 'Link', value: homepageDiscoveryLinkHeader },
					{ key: 'Vary', value: 'Accept' },
				],
			},
		])
		expect(homepageDiscoveryLinkHeader).toContain(
			'</api/openapi.json>; rel="service-desc"',
		)
		expect(homepageDiscoveryLinkHeader).toContain(
			'</llms.txt>; rel="service-doc"',
		)
	})
})
