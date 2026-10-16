import type { Course, Offer, WithContext } from 'schema-dts'
import config from '@/config'
import { JSON_LD_CURRENCY } from './json-ld-currency'
import { metaDescription } from './meta-description'

/** The page's already-selected single-seat list price, never a visitor/PPP quote. */
export type CourseOfferProduct = {
	price?: {
		unitAmount?: number | null
		fields?: Record<string, unknown>
	} | null
	fields?: { openEnrollment?: unknown; closeEnrollment?: unknown }
}
export type CourseSchemaInput = {
	title: string
	description?: string | null
	url: string
	product?: CourseOfferProduct | null
	quantityAvailable?: number | null
	startsAt?: string | null
	endsAt?: string | null
	now?: Date
}
function isoDate(value: unknown) {
	if (typeof value !== 'string' && !(value instanceof Date)) return undefined
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
export function buildCourseOffer({
	product,
	quantityAvailable,
	url,
	now = new Date(),
}: Pick<CourseSchemaInput, 'product' | 'quantityAvailable' | 'url' | 'now'>):
	| Offer
	| undefined {
	const amount = product?.price?.unitAmount
	if (
		typeof amount !== 'number' ||
		!Number.isFinite(amount) ||
		amount <= 0 ||
		typeof quantityAvailable !== 'number' ||
		!Number.isInteger(quantityAvailable) ||
		quantityAvailable < -1
	)
		return undefined
	const availabilityStarts = isoDate(product?.fields?.openEnrollment)
	const availabilityEnds = isoDate(product?.fields?.closeEnrollment)
	if (
		(product?.fields?.openEnrollment && !availabilityStarts) ||
		(product?.fields?.closeEnrollment && !availabilityEnds)
	)
		return undefined
	// Match offerInJsonLd's enrollment gate: no offer before doors open or after they close.
	if (
		(availabilityStarts && new Date(availabilityStarts) > now) ||
		(availabilityEnds && new Date(availabilityEnds) <= now)
	)
		return undefined
	return {
		'@type': 'Offer',
		price: amount,
		priceCurrency: JSON_LD_CURRENCY,
		availability:
			quantityAvailable === 0
				? 'https://schema.org/SoldOut'
				: 'https://schema.org/InStock',
		url,
		...(availabilityStarts ? { availabilityStarts } : {}),
		...(availabilityEnds ? { availabilityEnds } : {}),
	}
}
export function buildCourseSchema(
	input: CourseSchemaInput,
): WithContext<Course> {
	const offers = buildCourseOffer(input)
	const description = metaDescription(input.description)
	const startDate = isoDate(input.startsAt)
	const endDate = isoDate(input.endsAt)
	return {
		'@context': 'https://schema.org',
		'@type': 'Course',
		name: input.title,
		...(description ? { description } : {}),
		url: input.url,
		provider: { '@type': 'Organization', name: 'AI Hero', url: config.siteUrl },
		...(offers ? { offers } : {}),
		...(startDate || endDate
			? {
					hasCourseInstance: {
						'@type': 'CourseInstance',
						courseMode: 'online',
						...(startDate ? { startDate } : {}),
						...(endDate ? { endDate } : {}),
					},
				}
			: {}),
	}
}
