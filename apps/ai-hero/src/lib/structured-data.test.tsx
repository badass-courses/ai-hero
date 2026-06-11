import * as React from 'react'
import type { Post } from '@/lib/posts'
import {
	buildBreadcrumbStructuredData,
	buildContentResourceArticleStructuredData,
	buildCourseStructuredData,
	buildProductStructuredData,
	FaqStructuredData,
	PostStructuredData,
	ProductStructuredData,
	SiteStructuredData,
	STRUCTURED_DATA_SCRIPT_IDS,
} from '@/lib/structured-data'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { Product } from '@coursebuilder/core/schemas'

function getJsonLdFromMarkup(markup: string, scriptId: string) {
	const scriptMatcher = new RegExp(
		`<script[^>]*id=\"${scriptId}\"[^>]*>([\\s\\S]*?)<\\/script>`,
	)
	const match = markup.match(scriptMatcher)

	if (!match?.[1]) {
		throw new Error(`Unable to find JSON-LD script with id "${scriptId}"`)
	}

	return JSON.parse(match[1])
}

const samplePost: Post = {
	id: 'post-1',
	type: 'post',
	createdById: 'user-1',
	currentVersionId: null,
	fields: {
		postType: 'article',
		body: '## Build it fast\n\nShip the thing.',
		title: 'Ship Better AI Agents',
		summary: 'A practical guide to shipping better AI agents.',
		description: 'A practical guide to shipping better AI agents.',
		slug: 'ship-better-ai-agents',
		state: 'published',
		visibility: 'public',
		github: null,
		gitpod: null,
		thumbnailTime: null,
	},
	slug: 'ship-better-ai-agents',
	createdAt: new Date('2024-05-01T12:00:00.000Z'),
	updatedAt: new Date('2024-05-02T12:00:00.000Z'),
	deletedAt: null,
	resources: [],
	resourceProducts: [],
	organizationId: null,
	createdByOrganizationMembershipId: null,
	tags: null,
}

const sampleProduct: Product = {
	id: 'product-1',
	organizationId: null,
	name: 'AI Hero Masterclass',
	key: null,
	type: 'self-paced',
	fields: {
		body: 'A punchy course body.',
		description: 'Learn to build AI products that don’t suck.',
		slug: 'ai-hero-masterclass',
		image: {
			url: 'https://example.com/ai-hero-masterclass.png',
			alt: 'AI Hero Masterclass cover image',
			width: 1200,
			height: 630,
		},
		action: 'Buy Now',
		state: 'published',
		visibility: 'public',
		openEnrollment: null,
		closeEnrollment: null,
		discordRoleId: null,
		tier: null,
		billingInterval: null,
	},
	createdAt: new Date('2024-05-01T12:00:00.000Z'),
	status: 1,
	quantityAvailable: 25,
	price: {
		id: 'price-1',
		productId: 'product-1',
		organizationId: null,
		nickname: 'Launch price',
		status: 1,
		unitAmount: 199,
		createdAt: new Date('2024-05-01T12:00:00.000Z'),
		fields: {},
	},
	resources: [],
}

describe('structured data', () => {
	it('renders site-wide organization and website schema in HTML', () => {
		const markup = renderToStaticMarkup(<SiteStructuredData />)
		const organization = getJsonLdFromMarkup(
			markup,
			STRUCTURED_DATA_SCRIPT_IDS.organization,
		)
		const website = getJsonLdFromMarkup(
			markup,
			STRUCTURED_DATA_SCRIPT_IDS.website,
		)

		expect(organization['@type']).toBe('Organization')
		expect(organization.url).toBe('http://localhost:3000')
		expect(website['@type']).toBe('WebSite')
		expect(website.url).toBe('http://localhost:3000')
	})

	it('renders post blog posting schema with the canonical public URL', () => {
		const markup = renderToStaticMarkup(
			<PostStructuredData post={samplePost} />,
		)
		const blogPosting = getJsonLdFromMarkup(
			markup,
			STRUCTURED_DATA_SCRIPT_IDS.post,
		)

		expect(blogPosting['@type']).toBe('BlogPosting')
		expect(blogPosting.url).toBe('http://localhost:3000/ship-better-ai-agents')
		expect(blogPosting.mainEntityOfPage['@id']).toBe(
			'http://localhost:3000/ship-better-ai-agents',
		)
		expect(blogPosting.headline).toBe('Ship Better AI Agents')
	})

	it('renders product and offer schema with seller, currency, and stock facts', () => {
		const markup = renderToStaticMarkup(
			<ProductStructuredData product={sampleProduct} quantityAvailable={3} />,
		)
		const productSchema = getJsonLdFromMarkup(
			markup,
			STRUCTURED_DATA_SCRIPT_IDS.product,
		)

		expect(productSchema['@type']).toBe('Product')
		expect(productSchema.name).toBe('AI Hero Masterclass')
		expect(productSchema.offers).toEqual(
			expect.objectContaining({
				'@type': 'Offer',
				price: 199,
				priceCurrency: 'USD',
				availability: 'https://schema.org/InStock',
				seller: expect.objectContaining({
					name: 'Test Site',
				}),
			}),
		)
	})

	it('marks sold-out products as sold out in the offer schema', () => {
		const productSchema = buildProductStructuredData({
			product: sampleProduct,
			quantityAvailable: 0,
		})

		expect(productSchema.offers).toEqual(
			expect.objectContaining({
				availability: 'https://schema.org/SoldOut',
			}),
		)
	})

	it('uses a provided canonical path for product schema URLs', () => {
		const productSchema = buildProductStructuredData({
			product: sampleProduct,
			quantityAvailable: 3,
			canonicalPath: '/cohorts/ai-coding-for-real-engineers-m0k0w',
		})

		expect(productSchema.url).toBe(
			'http://localhost:3000/cohorts/ai-coding-for-real-engineers-m0k0w',
		)
	})

	it('builds Article and BreadcrumbList schema for content resources', () => {
		const article = buildContentResourceArticleStructuredData({
			resource: samplePost,
			canonicalPath: '/skills/skills-to-issues',
			section: 'AI Skills Changelog',
		})
		const breadcrumb = buildBreadcrumbStructuredData({
			items: [
				{ name: 'Home', path: '/' },
				{ name: 'AI Skills', path: '/skills' },
				{ name: 'To Issues', path: '/skills/skills-to-issues' },
			],
		})

		expect(article['@type']).toBe('Article')
		expect(article.url).toBe('http://localhost:3000/skills/skills-to-issues')
		expect(article.articleSection).toBe('AI Skills Changelog')
		expect(breadcrumb['@type']).toBe('BreadcrumbList')
		expect(breadcrumb.itemListElement).toHaveLength(3)
	})

	it('renders cohort course schema with canonical cohort URL and offer data', () => {
		const courseSchema = buildCourseStructuredData({
			cohort: {
				id: 'cohort-1',
				type: 'cohort',
				createdById: 'user-1',
				currentVersionId: null,
				fields: {
					title: 'AI Coding for Real Engineers',
					description: 'Learn AI coding workflows for production engineering.',
					slug: 'ai-coding-for-real-engineers-m0k0w',
					body: 'Cohort body',
					officeHoursSessions: [],
					state: 'published',
					visibility: 'public',
					startsAt: '2026-06-01T16:00:00.000Z',
					endsAt: '2026-06-12T16:00:00.000Z',
					timezone: 'America/Los_Angeles',
				},
				createdAt: new Date('2026-05-01T12:00:00.000Z'),
				updatedAt: new Date('2026-05-02T12:00:00.000Z'),
				deletedAt: null,
				resources: [],
				resourceProducts: [],
				organizationId: null,
				createdByOrganizationMembershipId: null,
			},
			product: sampleProduct,
			quantityAvailable: 5,
		})

		expect(courseSchema['@type']).toBe('Course')
		expect(courseSchema.url).toBe(
			'http://localhost:3000/cohorts/ai-coding-for-real-engineers-m0k0w',
		)
		expect(courseSchema.offers).toEqual(
			expect.objectContaining({
				'@type': 'Offer',
				price: 199,
				priceCurrency: 'USD',
				availability: 'https://schema.org/InStock',
			}),
		)
	})

	it('renders FAQ schema only when visible questions are present', () => {
		const markup = renderToStaticMarkup(
			<FaqStructuredData
				title="Frequently Asked Questions"
				questions={[
					{
						question: 'What is AI Hero?',
						answer: 'AI Hero helps developers build with AI faster.',
					},
				]}
			/>,
		)
		const faqPage = getJsonLdFromMarkup(markup, STRUCTURED_DATA_SCRIPT_IDS.faq)

		expect(faqPage['@type']).toBe('FAQPage')
		expect(faqPage.mainEntity).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					'@type': 'Question',
					name: 'What is AI Hero?',
					acceptedAnswer: expect.objectContaining({
						'@type': 'Answer',
						text: 'AI Hero helps developers build with AI faster.',
					}),
				}),
			]),
		)

		expect(
			renderToStaticMarkup(
				<FaqStructuredData title="Frequently Asked Questions" questions={[]} />,
			),
		).toBe('')
	})
})
