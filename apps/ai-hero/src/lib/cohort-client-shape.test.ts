import { describe, expect, it } from 'vitest'

import type { Product } from '@coursebuilder/core/schemas'

import type { Cohort, CohortPageProps } from './cohort'
import {
	toClientCohort,
	toClientCohortPageProps,
	toClientPricingProps,
	toClientProduct,
} from './cohort-client-shape'

const LESSON_BODY = 'LESSON_BODY_SENTINEL'
const SOLUTION = 'SOLUTION_SENTINEL'
const lesson = {
	id: 'sync_lesson_1',
	type: 'lesson',
	fields: { title: 'L', slug: 'l', body: LESSON_BODY, solution: SOLUTION },
}
const section = {
	id: 'section_1',
	type: 'section',
	fields: { body: LESSON_BODY },
	resources: [{ resource: lesson }],
}

const cohort = {
	id: 'cohort_1',
	type: 'cohort',
	fields: {
		title: 'A cohort',
		slug: 'a-cohort',
		body: 'SALES_BODY_SENTINEL',
		postPurchaseBody: 'POST_PURCHASE_SENTINEL',
		forTeamsBody: 'TEAMS_SENTINEL',
		state: 'published',
		visibility: 'public',
		timezone: 'America/Los_Angeles',
		startsAt: '2026-11-01T00:00:00.000Z',
		endsAt: '2026-12-01T00:00:00.000Z',
		image: 'https://example.com/i.png',
	},
	resources: [
		{ resource: lesson },
		{
			resource: {
				id: 'workshop_1',
				fields: { title: 'W', slug: 'w' },
				resources: [
					{
						resource: section,
					},
				],
			},
		},
	],
} as unknown as Cohort

describe('toClientCohort', () => {
	it('keeps no lesson body, nested resources, or body fields', () => {
		const json = JSON.stringify(toClientCohort(cohort))
		expect(json).not.toContain(LESSON_BODY)
		expect(json).not.toContain('SALES_BODY_SENTINEL')
		expect(json).not.toContain('POST_PURCHASE_SENTINEL')
		expect(json).not.toContain('TEAMS_SENTINEL')
		expect(json).not.toContain('sync_lesson_1')
		expect(toClientCohort(cohort).resources).toEqual([])
	})

	it('keeps what the pricing widget and sidebar read', () => {
		const shaped = toClientCohort(cohort)
		expect(shaped.id).toBe('cohort_1')
		expect(shaped.fields).toMatchObject({
			title: 'A cohort',
			slug: 'a-cohort',
			timezone: 'America/Los_Angeles',
			startsAt: '2026-11-01T00:00:00.000Z',
			endsAt: '2026-12-01T00:00:00.000Z',
			image: 'https://example.com/i.png',
		})
	})
})

const product = {
	id: 'product_1',
	name: 'Cohort',
	type: 'cohort',
	status: 1,
	createdAt: new Date('2026-10-01'),
	quantityAvailable: 50,
	fields: {
		slug: 'cohort-product',
		state: 'published',
		visibility: 'public',
		openEnrollment: '2026-10-01T00:00:00Z',
		body: LESSON_BODY,
		postPurchaseBody: SOLUTION,
	},
	price: {
		id: 'price_1',
		unitAmount: 499,
		fields: { offer: { offered: true } },
	},
	resources: [{ resource: cohort }],
} as unknown as Product

function expectNoContent(value: unknown) {
	const json = JSON.stringify(value)
	expect(json).not.toContain(LESSON_BODY)
	expect(json).not.toContain(SOLUTION)
	expect(json).not.toContain('sync_lesson_1')
	expect(json).not.toMatch(/"(?:body|solution|postPurchaseBody|forTeamsBody)":/)
}

describe('cohort page client boundaries', () => {
	it('shapes every main-page prop, not just the explicit sidebar cohort', async () => {
		const pricing = {
			quantityAvailable: 42,
			formattedPrice: { upgradedProduct: product, calculatedPrice: 499 },
			purchaseToUpgrade: { product },
		}
		const props = {
			cohort,
			product,
			products: [product],
			availableBonuses: [{ resource: section }],
			existingPurchase: { product },
			purchases: [{ product }],
			pricingDataLoader: Promise.resolve(pricing),
			quantityAvailable: 42,
			totalQuantity: 50,
			purchaseCount: 8,
		} as unknown as CohortPageProps
		const before = JSON.stringify(props)
		const client = toClientCohortPageProps(props)
		// Both the inline Pricing.Root spread and the rail spread use this envelope.
		expectNoContent(client)
		expectNoContent(await client.pricingDataLoader)
		expect(client.cohort.resources).toEqual([])
		expect(client.product?.resources).toEqual([])
		expect(client.products?.[0]?.resources).toEqual([])
		expect(client.existingPurchase?.product?.resources).toEqual([])
		expect(client.product?.createdAt).toBe(product.createdAt)
		expect(client.product?.price).toEqual(product.price)
		expect(client.product?.fields.openEnrollment).toBe(
			product.fields.openEnrollment,
		)
		expect((await client.pricingDataLoader).quantityAvailable).toBe(42)
		expect(JSON.stringify(props)).toBe(before)
		expect(JSON.stringify(await props.pricingDataLoader)).toContain(LESSON_BODY)
	})

	it('drops unknown product fields and relationships at the edit-button boundary', () => {
		const client = toClientProduct({
			...product,
			resourceProducts: [{ resource: cohort }],
			fields: { ...product.fields, futureContent: section },
		} as Product)
		expectNoContent(client)
		expect(client.fields).not.toHaveProperty('futureContent')
		expect(client).not.toHaveProperty('resourceProducts')
		expect(client.id).toBe(product.id)
		expect(client.fields.slug).toBe(product.fields.slug)
	})

	it('shapes team-page fallback and client pricing props, including deferred upgrades', async () => {
		const client = toClientPricingProps({
			product,
			products: [product],
			allowPurchase: true,
			country: 'US',
			pricingDataLoader: Promise.resolve({
				quantityAvailable: 42,
				formattedPrice: { upgradedProduct: product },
			}),
		})
		expectNoContent(client)
		expectNoContent(await client.pricingDataLoader)
		expect(client.allowPurchase).toBe(true)
		expect(client.country).toBe('US')
	})
})
