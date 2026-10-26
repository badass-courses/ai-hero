import type { Cohort, CohortPageProps } from '@/lib/cohort'

import type { Product } from '@coursebuilder/core/schemas'

/** Everything sent to a client component is public, including unused props. */
const CLIENT_COHORT_FIELDS = [
	'title',
	'description',
	'slug',
	'state',
	'visibility',
	'startsAt',
	'endsAt',
	'timezone',
	'image',
] as const

const CLIENT_PRODUCT_FIELDS = [
	'description',
	'slug',
	'image',
	'action',
	'state',
	'visibility',
	'openEnrollment',
	'closeEnrollment',
	'availableAfterDays',
	'accessDurationDays',
	'tier',
	'billingInterval',
	'defaultPriceId',
	'pricingSource',
	'stripeDefaultPriceIdentifier',
	'stripeLivemode',
] as const

export type ClientCohort = Cohort

/** Keeps display fields only, regardless of access or resource-tree depth. */
export function toClientCohort(cohort: Cohort): ClientCohort {
	const fields: Record<string, unknown> = {}
	for (const key of CLIENT_COHORT_FIELDS) {
		if (cohort.fields[key] !== undefined) fields[key] = cohort.fields[key]
	}
	return {
		id: cohort.id,
		type: cohort.type,
		fields,
		resources: [],
	} as unknown as ClientCohort
}

/** Product display and commerce facts, never the attached content graph. */
export function toClientProduct(product: Product): Product {
	const fields = Object.fromEntries(
		CLIENT_PRODUCT_FIELDS.filter(
			(key) => product.fields[key] !== undefined,
		).map((key) => [key, product.fields[key]]),
	) as Pick<Product['fields'], (typeof CLIENT_PRODUCT_FIELDS)[number]>
	return withoutContent({
		id: product.id,
		organizationId: product.organizationId,
		name: product.name,
		key: product.key,
		type: product.type,
		fields,
		createdAt: product.createdAt,
		status: product.status,
		quantityAvailable: product.quantityAvailable,
		price: product.price,
		prices: product.prices,
		resources: [],
	})
}

/**
 * Defense for commerce envelopes too: upgrades and purchases can embed products,
 * and pricing arrives in a promise that React serializes after it resolves.
 * Preserve dates and promises rather than JSON-roundtripping commerce facts.
 * The compatibility type retains the existing widget API, not full server data.
 */
function withoutContent<T>(value: T): T {
	if (value === null || typeof value !== 'object' || value instanceof Date) {
		return value
	}
	if (value instanceof Promise) {
		return value.then(withoutContent) as T
	}
	if (Array.isArray(value)) return value.map(withoutContent) as T
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			if (/body$/i.test(key) || key === 'solution') return []
			return [
				[
					key,
					key === 'resources' || key === 'resourceProducts'
						? []
						: withoutContent(item),
				],
			]
		}),
	) as T
}

/** Shared boundary for main-page and team-page pricing, including prop spreads. */
export function toClientPricingProps<
	T extends { product?: Product | null; products?: Product[] },
>(props: T): T {
	return withoutContent({
		...props,
		...(props.product ? { product: toClientProduct(props.product) } : {}),
		...(props.products
			? { products: props.products.map(toClientProduct) }
			: {}),
	})
}

/** Shape once, then use this envelope at every cohort client boundary. */
export function toClientCohortPageProps(
	props: CohortPageProps,
): CohortPageProps {
	return toClientPricingProps({
		...props,
		cohort: toClientCohort(props.cohort),
	})
}
