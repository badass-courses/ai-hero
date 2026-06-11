import * as React from 'react'
import config from '@/config'
import { env } from '@/env.mjs'
import {
	AI_CODING_DICTIONARY_DESCRIPTION,
	AI_CODING_DICTIONARY_TITLE,
	getAiCodingDictionaryOgImageUrl,
	type DictionaryData,
	type DictionaryEntry,
} from '@/lib/ai-coding-dictionary'
import type { Post } from '@/lib/posts'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import type {
	Article,
	BlogPosting,
	BreadcrumbList,
	Course,
	FAQPage,
	Offer,
	Organization,
	Product as ProductSchema,
	Question,
	WebSite,
	WithContext,
} from 'schema-dts'

import type { ContentResource, Product } from '@coursebuilder/core/schemas'

import type { Cohort } from './cohort'

const SCHEMA_ORG_CONTEXT = 'https://schema.org' as const

export const STRUCTURED_DATA_SCRIPT_IDS = {
	organization: 'organization-jsonld',
	website: 'website-jsonld',
	post: 'post-jsonld',
	product: 'product-jsonld',
	course: 'course-jsonld',
	faq: 'faq-jsonld',
	dictionary: 'dictionary-jsonld',
	dictionaryEntry: 'dictionary-entry-jsonld',
	article: 'article-jsonld',
	breadcrumb: 'breadcrumb-jsonld',
} as const

type FaqQuestion = {
	question: string
	answer: string
}

type PersonReference = {
	'@type': 'Person'
	name: string
	sameAs?: string[]
}

type OrganizationReference = {
	'@type': 'Organization'
	name: string
	url: string
	email: string
	sameAs?: string[]
}

function collapseWhitespace(value: string) {
	return value.replace(/\s+/g, ' ').trim()
}

function sanitizeText(value?: string | null) {
	if (!value) return undefined

	const sanitized = collapseWhitespace(value.replace(/\bundefined\b/gi, ''))

	return sanitized.length > 0 ? sanitized : undefined
}

function getSiteName() {
	return (
		sanitizeText(env.NEXT_PUBLIC_SITE_TITLE) ||
		sanitizeText(config.defaultTitle) ||
		'AI Hero'
	)
}

function getSiteDescription() {
	return sanitizeText(config.description)
}

function getAuthorName() {
	return sanitizeText(config.author) || getSiteName()
}

function getSameAsLinks() {
	return config.sameAs
		.map((value) => sanitizeText(value))
		.filter((value): value is string => Boolean(value))
}

function toPublicUrl(path = '/') {
	return new URL(path, `${env.NEXT_PUBLIC_URL}/`).toString()
}

function toIsoDateString(value?: Date | string | null) {
	if (!value) return undefined

	const date = value instanceof Date ? value : new Date(value)

	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function buildAuthorReference(): PersonReference {
	const sameAs = getSameAsLinks()

	return {
		'@type': 'Person',
		name: getAuthorName(),
		...(sameAs.length > 0 ? { sameAs } : {}),
	}
}

function buildOrganizationReference(): OrganizationReference {
	const sameAs = getSameAsLinks()

	return {
		'@type': 'Organization',
		name: getSiteName(),
		url: env.NEXT_PUBLIC_URL,
		email: env.NEXT_PUBLIC_SUPPORT_EMAIL,
		...(sameAs.length > 0 ? { sameAs } : {}),
	}
}

function serializeJsonLd(data: unknown) {
	return JSON.stringify(data).replace(/</g, '\\u003c')
}

export function buildOrganizationStructuredData(): WithContext<Organization> {
	const description = getSiteDescription()
	const organization = buildOrganizationReference()

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'Organization',
		name: organization.name,
		url: organization.url,
		email: organization.email,
		...(organization.sameAs ? { sameAs: organization.sameAs } : {}),
		...(description ? { description } : {}),
		logo: toPublicUrl('/apple-touch-icon.png'),
		founder: buildAuthorReference(),
	}
}

export function buildWebsiteStructuredData(): WithContext<WebSite> {
	const description = getSiteDescription()

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'WebSite',
		name: getSiteName(),
		url: env.NEXT_PUBLIC_URL,
		inLanguage: 'en-US',
		publisher: buildOrganizationReference(),
		creator: buildAuthorReference(),
		...(description ? { description } : {}),
	}
}

export function buildDictionaryStructuredData(dictionary: DictionaryData) {
	const canonicalUrl = toPublicUrl('/ai-coding-dictionary')
	const termSetId = `${canonicalUrl}#defined-term-set`
	const webpageId = `${canonicalUrl}#webpage`
	const description = AI_CODING_DICTIONARY_DESCRIPTION
	const image = toPublicUrl(getAiCodingDictionaryOgImageUrl())
	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@graph': [
			{
				'@type': 'CollectionPage',
				'@id': webpageId,
				url: canonicalUrl,
				name: AI_CODING_DICTIONARY_TITLE,
				description,
				image,
				thumbnailUrl: image,
				inLanguage: 'en-US',
				isPartOf: {
					'@type': 'WebSite',
					'@id': `${env.NEXT_PUBLIC_URL}#website`,
					name: getSiteName(),
					url: env.NEXT_PUBLIC_URL,
				},
				about: { '@id': termSetId },
				mainEntity: { '@id': termSetId },
				publisher: buildOrganizationReference(),
				creator: buildAuthorReference(),
				dateModified: toIsoDateString(dictionary.updatedAt),
			},
			{
				'@type': 'DefinedTermSet',
				'@id': termSetId,
				name: AI_CODING_DICTIONARY_TITLE,
				description,
				url: canonicalUrl,
				hasDefinedTerm: dictionary.entries.map((entry) => ({
					'@type': 'DefinedTerm',
					'@id': `${toPublicUrl(`/ai-coding-dictionary/${entry.slug}`)}#defined-term`,
					name: entry.title,
					termCode: entry.slug,
					description: sanitizeText(entry.description),
					url: toPublicUrl(`/ai-coding-dictionary/${entry.slug}`),
					inDefinedTermSet: { '@id': termSetId },
				})),
			},
			{
				'@type': 'ItemList',
				'@id': `${canonicalUrl}#item-list`,
				name: `${AI_CODING_DICTIONARY_TITLE} terms`,
				numberOfItems: dictionary.entries.length,
				itemListElement: dictionary.entries.map((entry, index) => ({
					'@type': 'ListItem',
					position: index + 1,
					name: entry.title,
					url: toPublicUrl(`/ai-coding-dictionary/${entry.slug}`),
				})),
			},
			{
				'@type': 'BreadcrumbList',
				'@id': `${canonicalUrl}#breadcrumb`,
				itemListElement: [
					{
						'@type': 'ListItem',
						position: 1,
						name: 'Home',
						item: toPublicUrl('/'),
					},
					{
						'@type': 'ListItem',
						position: 2,
						name: AI_CODING_DICTIONARY_TITLE,
						item: canonicalUrl,
					},
				],
			},
		],
	}
}

export function buildDictionaryEntryStructuredData({
	entry,
	dictionary,
}: {
	entry: DictionaryEntry
	dictionary: DictionaryData
}) {
	const canonicalUrl = toPublicUrl(`/ai-coding-dictionary/${entry.slug}`)
	const dictionaryUrl = toPublicUrl('/ai-coding-dictionary')
	const termSetId = `${dictionaryUrl}#defined-term-set`
	const termId = `${canonicalUrl}#defined-term`
	const webpageId = `${canonicalUrl}#webpage`
	const description = sanitizeText(entry.description)
	const image = toPublicUrl(
		getAiCodingDictionaryOgImageUrl(
			`${entry.title} | ${AI_CODING_DICTIONARY_TITLE}`,
		),
	)

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@graph': [
			{
				'@type': 'WebPage',
				'@id': webpageId,
				url: canonicalUrl,
				name: `${entry.title} | ${AI_CODING_DICTIONARY_TITLE}`,
				...(description ? { description } : {}),
				image,
				thumbnailUrl: image,
				inLanguage: 'en-US',
				isPartOf: {
					'@type': 'WebSite',
					'@id': `${env.NEXT_PUBLIC_URL}#website`,
					name: getSiteName(),
					url: env.NEXT_PUBLIC_URL,
				},
				mainEntity: { '@id': termId },
				breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
				publisher: buildOrganizationReference(),
				creator: buildAuthorReference(),
				dateModified: toIsoDateString(dictionary.updatedAt),
			},
			{
				'@type': 'DefinedTerm',
				'@id': termId,
				name: entry.title,
				termCode: entry.slug,
				...(description ? { description } : {}),
				url: canonicalUrl,
				inDefinedTermSet: {
					'@type': 'DefinedTermSet',
					'@id': termSetId,
					name: AI_CODING_DICTIONARY_TITLE,
					url: dictionaryUrl,
				},
				subjectOf: { '@id': webpageId },
			},
			{
				'@type': 'Article',
				'@id': `${canonicalUrl}#article`,
				headline: entry.title,
				url: canonicalUrl,
				image,
				...(description ? { description } : {}),
				articleSection: entry.sectionTitle,
				about: { '@id': termId },
				mainEntityOfPage: { '@id': webpageId },
				author: buildAuthorReference(),
				publisher: buildOrganizationReference(),
				dateModified: toIsoDateString(dictionary.updatedAt),
			},
			{
				'@type': 'BreadcrumbList',
				'@id': `${canonicalUrl}#breadcrumb`,
				itemListElement: [
					{
						'@type': 'ListItem',
						position: 1,
						name: 'Home',
						item: toPublicUrl('/'),
					},
					{
						'@type': 'ListItem',
						position: 2,
						name: AI_CODING_DICTIONARY_TITLE,
						item: dictionaryUrl,
					},
					{
						'@type': 'ListItem',
						position: 3,
						name: entry.title,
						item: canonicalUrl,
					},
				],
			},
		],
	}
}

/**
 * Builds BreadcrumbList JSON-LD for a public page path.
 *
 * @param items - Ordered breadcrumb items with display names and site-relative paths.
 * @returns Schema.org BreadcrumbList data ready for StructuredDataScript.
 *
 * @example
 * ```ts
 * buildBreadcrumbStructuredData({ items: [{ name: 'Home', path: '/' }] })
 * ```
 */
export function buildBreadcrumbStructuredData({
	items,
}: {
	items: Array<{ name: string; path: string }>
}): WithContext<BreadcrumbList> {
	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'BreadcrumbList',
		itemListElement: items.map((item, index) => ({
			'@type': 'ListItem',
			position: index + 1,
			name: item.name,
			item: toPublicUrl(item.path),
		})),
	}
}

/**
 * Builds Article JSON-LD for content resources rendered outside the normal post route.
 *
 * @param resource - The content resource that supplies title, summary, dates, and image data.
 * @param canonicalPath - Site-relative canonical path for the rendered page.
 * @param section - Optional article section label.
 * @returns Schema.org Article data ready for StructuredDataScript.
 *
 * @example
 * ```ts
 * buildContentResourceArticleStructuredData({ resource, canonicalPath: '/skills/example' })
 * ```
 */
export function buildContentResourceArticleStructuredData({
	resource,
	canonicalPath,
	section,
}: {
	resource: ContentResource
	canonicalPath: string
	section?: string
}): WithContext<Article> {
	const canonicalUrl = toPublicUrl(canonicalPath)
	const title = sanitizeText(resource.fields?.title) || canonicalUrl
	const description =
		sanitizeText(resource.fields?.summary) ||
		sanitizeText(resource.fields?.description)

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'Article',
		headline: title,
		url: canonicalUrl,
		mainEntityOfPage: {
			'@type': 'WebPage',
			'@id': canonicalUrl,
		},
		author: buildAuthorReference(),
		publisher: buildOrganizationReference(),
		image: getOGImageUrlForResource({
			id: resource.id,
			fields: { slug: String(resource.fields?.slug ?? resource.id) },
			updatedAt: resource.updatedAt,
		}),
		datePublished: toIsoDateString(resource.createdAt),
		dateModified: toIsoDateString(resource.updatedAt || resource.createdAt),
		isAccessibleForFree: true,
		...(section ? { articleSection: section } : {}),
		...(description ? { description } : {}),
	}
}

/**
 * Builds BlogPosting JSON-LD for a published AI Hero post.
 *
 * @param post - Post content resource with slug, title, summary, and timestamps.
 * @returns Schema.org BlogPosting data ready for StructuredDataScript.
 *
 * @example
 * ```ts
 * buildPostStructuredData(post)
 * ```
 */
export function buildPostStructuredData(post: Post): WithContext<BlogPosting> {
	const canonicalUrl = toPublicUrl(`/${post.fields.slug}`)
	const description =
		sanitizeText(post.fields.summary) || sanitizeText(post.fields.description)

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'BlogPosting',
		headline: collapseWhitespace(post.fields.title),
		url: canonicalUrl,
		mainEntityOfPage: {
			'@type': 'WebPage',
			'@id': canonicalUrl,
		},
		author: buildAuthorReference(),
		publisher: buildOrganizationReference(),
		image: getOGImageUrlForResource({
			id: post.id,
			fields: { slug: post.fields.slug },
			updatedAt: post.updatedAt,
		}),
		datePublished: toIsoDateString(post.createdAt),
		dateModified: toIsoDateString(post.updatedAt || post.createdAt),
		isAccessibleForFree: true,
		...(description ? { description } : {}),
	}
}

function getProductAvailability(quantityAvailable: number) {
	return quantityAvailable === 0
		? 'https://schema.org/SoldOut'
		: 'https://schema.org/InStock'
}

/**
 * Builds Product JSON-LD and its Offer for a sellable Course Builder product.
 *
 * @param product - Product record with name, slug, price, image, and description fields.
 * @param quantityAvailable - Available inventory used to choose InStock or SoldOut.
 * @param canonicalPath - Optional site-relative URL override for products sold on non-product pages.
 * @returns Schema.org Product data with a nested Offer.
 *
 * @example
 * ```ts
 * buildProductStructuredData({ product, quantityAvailable: 5, canonicalPath: '/cohorts/cohort-slug' })
 * ```
 */
export function buildProductStructuredData({
	product,
	quantityAvailable,
	canonicalPath,
}: {
	product: Product
	quantityAvailable: number
	canonicalPath?: string
}): WithContext<ProductSchema> {
	const canonicalUrl = toPublicUrl(
		canonicalPath || `/products/${product.fields?.slug || product.id}`,
	)
	const offer: Offer = {
		'@type': 'Offer',
		url: canonicalUrl,
		priceCurrency: 'USD',
		price: product.price?.unitAmount,
		availability: getProductAvailability(quantityAvailable),
		seller: buildOrganizationReference(),
	}

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'Product',
		name: collapseWhitespace(product.name),
		url: canonicalUrl,
		sku: product.id,
		category: product.type || undefined,
		description: sanitizeText(product.fields?.description),
		image:
			product.fields?.image?.url ||
			getOGImageUrlForResource({
				...product,
				fields: {
					...product.fields,
					slug: product.fields?.slug || product.id,
				},
			}),
		offers: offer,
	}
}

/**
 * Builds Course JSON-LD for an AI Hero cohort page.
 *
 * @param cohort - Cohort content resource with title, slug, dates, and description fields.
 * @param product - Optional linked product used to add offer data.
 * @param quantityAvailable - Available product inventory used for offer availability.
 * @returns Schema.org Course data with optional Offer details.
 *
 * @example
 * ```ts
 * buildCourseStructuredData({ cohort, product, quantityAvailable: 10 })
 * ```
 */
export function buildCourseStructuredData({
	cohort,
	product,
	quantityAvailable,
}: {
	cohort: Cohort
	product?: Product | null
	quantityAvailable: number
}): WithContext<Course> {
	const canonicalUrl = toPublicUrl(`/cohorts/${cohort.fields.slug}`)
	const description = sanitizeText(cohort.fields.description)
	const image = cohort.fields.socialImage?.url || cohort.fields.image
	const offers = product
		? {
				'@type': 'Offer' as const,
				url: canonicalUrl,
				priceCurrency: 'USD',
				price: product.price?.unitAmount,
				availability: getProductAvailability(quantityAvailable),
				seller: buildOrganizationReference(),
				availabilityStarts: toIsoDateString(
					product.fields?.openEnrollment as string | undefined,
				),
				availabilityEnds: toIsoDateString(
					product.fields?.closeEnrollment as string | undefined,
				),
			}
		: undefined

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'Course',
		name: collapseWhitespace(cohort.fields.title),
		url: canonicalUrl,
		provider: buildOrganizationReference(),
		creator: buildAuthorReference(),
		inLanguage: 'en-US',
		isAccessibleForFree: false,
		...(description ? { description } : {}),
		...(image ? { image } : {}),
		...(cohort.fields.startsAt ? { startDate: cohort.fields.startsAt } : {}),
		...(cohort.fields.endsAt ? { endDate: cohort.fields.endsAt } : {}),
		...(offers ? { offers } : {}),
	} as WithContext<Course>
}

/**
 * Builds FAQPage JSON-LD when at least one visible question and answer exists.
 *
 * @param title - Optional FAQ page title used as the schema name.
 * @param questions - Candidate FAQ entries. Empty questions or answers are filtered out.
 * @returns Schema.org FAQPage data, or null when there is no publishable FAQ content.
 *
 * @example
 * ```ts
 * buildFaqStructuredData({ title: 'FAQ', questions })
 * ```
 */
export function buildFaqStructuredData({
	title,
	questions,
}: {
	title?: string | null
	questions: FaqQuestion[]
}): WithContext<FAQPage> | null {
	if (questions.length === 0) {
		return null
	}

	const mainEntity: Question[] = questions
		.filter((entry) => entry.question && entry.answer)
		.map((entry) => ({
			'@type': 'Question',
			name: collapseWhitespace(entry.question),
			acceptedAnswer: {
				'@type': 'Answer',
				text: collapseWhitespace(entry.answer),
			},
		}))

	if (mainEntity.length === 0) {
		return null
	}

	return {
		'@context': SCHEMA_ORG_CONTEXT,
		'@type': 'FAQPage',
		name: sanitizeText(title) || 'Frequently Asked Questions',
		mainEntity,
	}
}

/**
 * Renders a non-visual JSON-LD script tag for schema.org data.
 *
 * @param data - JSON-LD object to serialize. Falsy values render nothing.
 * @param id - Optional DOM id for the script tag.
 * @returns A script element containing serialized JSON-LD, or null when data is empty.
 */
export function StructuredDataScript({
	data,
	id,
}: {
	data: unknown
	id?: string
}) {
	if (!data) return null

	return (
		<script
			id={id}
			type="application/ld+json"
			dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
		/>
	)
}

/**
 * Renders site-wide Organization and WebSite JSON-LD.
 *
 * @returns Non-visual JSON-LD script elements for global AI Hero metadata.
 */
export function SiteStructuredData() {
	return (
		<>
			<StructuredDataScript
				id={STRUCTURED_DATA_SCRIPT_IDS.organization}
				data={buildOrganizationStructuredData()}
			/>
			<StructuredDataScript
				id={STRUCTURED_DATA_SCRIPT_IDS.website}
				data={buildWebsiteStructuredData()}
			/>
		</>
	)
}

/**
 * Renders CollectionPage JSON-LD for the AI Coding Dictionary index.
 *
 * @param dictionary - Dictionary title, description, entries, and update timestamp.
 * @returns A non-visual JSON-LD script element.
 */
export function DictionaryStructuredData({
	dictionary,
}: {
	dictionary: DictionaryData
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.dictionary}
			data={buildDictionaryStructuredData(dictionary)}
		/>
	)
}

/**
 * Renders DefinedTerm JSON-LD for one AI Coding Dictionary entry.
 *
 * @param entry - Dictionary entry being rendered.
 * @param dictionary - Parent dictionary metadata used for breadcrumbs and collection context.
 * @returns A non-visual JSON-LD script element.
 */
export function DictionaryEntryStructuredData({
	entry,
	dictionary,
}: {
	entry: DictionaryEntry
	dictionary: DictionaryData
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.dictionaryEntry}
			data={buildDictionaryEntryStructuredData({ entry, dictionary })}
		/>
	)
}

/**
 * Renders Article JSON-LD for a content resource page.
 *
 * @param resource - The content resource used to build Article schema.
 * @param canonicalPath - Site-relative canonical path for the page.
 * @param section - Optional article section label.
 * @returns A non-visual JSON-LD script element.
 */
export function ArticleStructuredData({
	resource,
	canonicalPath,
	section,
}: {
	resource: ContentResource
	canonicalPath: string
	section?: string
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.article}
			data={buildContentResourceArticleStructuredData({
				resource,
				canonicalPath,
				section,
			})}
		/>
	)
}

/**
 * Renders BreadcrumbList JSON-LD for a page.
 *
 * @param items - Ordered breadcrumb labels and site-relative paths.
 * @returns A non-visual JSON-LD script element.
 */
export function BreadcrumbStructuredData({
	items,
}: {
	items: Array<{ name: string; path: string }>
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.breadcrumb}
			data={buildBreadcrumbStructuredData({ items })}
		/>
	)
}

/**
 * Renders BlogPosting JSON-LD for a post page.
 *
 * @param post - Post content resource used to build the BlogPosting schema.
 * @returns A non-visual JSON-LD script element.
 */
export function PostStructuredData({ post }: { post: Post }) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.post}
			data={buildPostStructuredData(post)}
		/>
	)
}

/**
 * Renders Product JSON-LD for product or cohort purchase pages.
 *
 * @param product - Product record used to build Product schema.
 * @param quantityAvailable - Available inventory used for offer availability.
 * @param canonicalPath - Optional site-relative URL override.
 * @returns A non-visual JSON-LD script element.
 */
export function ProductStructuredData({
	product,
	quantityAvailable,
	canonicalPath,
}: {
	product: Product
	quantityAvailable: number
	canonicalPath?: string
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.product}
			data={buildProductStructuredData({
				product,
				quantityAvailable,
				canonicalPath,
			})}
		/>
	)
}

/**
 * Renders Course JSON-LD for a cohort page.
 *
 * @param cohort - Cohort resource used to build Course schema.
 * @param product - Optional product record used for offer data.
 * @param quantityAvailable - Available inventory used for offer availability.
 * @returns A non-visual JSON-LD script element.
 */
export function CourseStructuredData({
	cohort,
	product,
	quantityAvailable,
}: {
	cohort: Cohort
	product?: Product | null
	quantityAvailable: number
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.course}
			data={buildCourseStructuredData({ cohort, product, quantityAvailable })}
		/>
	)
}

/**
 * Renders FAQPage JSON-LD when the page has visible FAQ content.
 *
 * @param title - Optional FAQ title.
 * @param questions - FAQ entries to serialize.
 * @returns A non-visual JSON-LD script element, with null data when no FAQ should render.
 */
export function FaqStructuredData({
	title,
	questions,
}: {
	title?: string | null
	questions: FaqQuestion[]
}) {
	return (
		<StructuredDataScript
			id={STRUCTURED_DATA_SCRIPT_IDS.faq}
			data={buildFaqStructuredData({ title, questions })}
		/>
	)
}
