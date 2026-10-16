import type { Course, Offer, WithContext } from 'schema-dts'
import { metaDescription } from './meta-description'

/** The primary single-seat list price, not a visitor's discounted/PPP quote. */
export type CourseOfferProduct = {
	price?: {
		unitAmount?: number | null
		fields?: {
			stripe?: { currency: string; active: boolean; supported: boolean }
		}
	} | null
}

export type CourseSchemaInput = {
	title: string
	description?: string | null
	url: string
	product?: CourseOfferProduct | null
	/** Resolved by the same seatsTaken/seatsLeft rule as pricing; -1 means unlimited. */
	quantityAvailable?: number | null
	startsAt?: string | null
	endsAt?: string | null
}

function isoDate(value?: string | null) {
	if (!value) return undefined
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function buildCourseOffer({
	product,
	quantityAvailable,
	url,
}: Pick<CourseSchemaInput, 'product' | 'quantityAvailable' | 'url'>):
	| Offer
	| undefined {
	const price = product?.price
	const catalog = price?.fields?.stripe
	const amount = price?.unitAmount
	if (
		typeof amount !== 'number' ||
		!Number.isFinite(amount) ||
		amount <= 0 ||
		!catalog?.active ||
		!catalog.supported ||
		!/^[a-z]{3}$/i.test(catalog.currency) ||
		typeof quantityAvailable !== 'number' ||
		!Number.isInteger(quantityAvailable) ||
		quantityAvailable < -1
	)
		return undefined
	return {
		'@type': 'Offer',
		price: amount,
		priceCurrency: catalog.currency.toUpperCase(),
		availability:
			quantityAvailable === 0
				? 'https://schema.org/SoldOut'
				: 'https://schema.org/InStock',
		url,
	}
}

/** Typed without casts: dates belong on CourseInstance, not Course. Unknown commerce facts are omitted. */
export function buildCourseSchema(
	input: CourseSchemaInput,
): WithContext<Course> {
	const offers = buildCourseOffer(input)
	const startDate = isoDate(input.startsAt)
	const endDate = isoDate(input.endsAt)
	return {
		'@context': 'https://schema.org',
		'@type': 'Course',
		name: input.title,
		description: metaDescription(input.description),
		url: input.url,
		provider: {
			'@type': 'Organization',
			name: 'AI Hero',
			url: 'https://www.aihero.dev',
		},
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
