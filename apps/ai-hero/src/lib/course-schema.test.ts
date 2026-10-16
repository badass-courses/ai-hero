import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { Course, WithContext } from 'schema-dts'
import { z } from 'zod'
import type { Product } from '@coursebuilder/core/schemas'
import { buildCourseSchema } from './course-schema'
import { buildProductStructuredData } from './structured-data'

vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://www.aihero.dev' },
}))

// Exact getProduct shape, with legacy AI_Price.fields = {} (no Stripe catalog facts).
const product: Product = {
	id: 'product-synthetic',
	name: 'Synthetic course',
	type: 'self-paced',
	key: null,
	status: 1,
	organizationId: null,
	quantityAvailable: 10,
	createdAt: new Date('2026-10-01T00:00:00Z'),
	resources: [],
	fields: {
		slug: 'synthetic-course',
		state: 'published',
		visibility: 'public',
		description: 'Learn engineering.',
		body: '',
		action: 'Buy Now',
		image: null,
		openEnrollment: null,
		closeEnrollment: null,
		discordRoleId: null,
		tier: null,
		billingInterval: null,
	},
	price: {
		id: 'price-synthetic',
		productId: 'product-synthetic',
		organizationId: null,
		nickname: null,
		status: 1,
		unitAmount: 247.5,
		createdAt: new Date('2026-10-01T00:00:00Z'),
		fields: {},
	},
}
const input = {
	title: 'Synthetic course',
	description: 'Learn *engineering*.',
	url: 'https://www.aihero.dev/workshops/synthetic-course',
	product,
	quantityAvailable: 3,
}
const offerSchema = z
	.object({
		'@type': z.literal('Offer'),
		price: z.number().positive(),
		priceCurrency: z.literal('USD'),
		availability: z.enum([
			'https://schema.org/InStock',
			'https://schema.org/SoldOut',
		]),
		url: z.string().url(),
		availabilityStarts: z.string().datetime().optional(),
		availabilityEnds: z.string().datetime().optional(),
	})
	.strict()
const courseSchema = z
	.object({
		'@context': z.literal('https://schema.org'),
		'@type': z.literal('Course'),
		name: z.string().min(1),
		description: z.string().optional(),
		url: z.string().url(),
		provider: z
			.object({
				'@type': z.literal('Organization'),
				name: z.literal('AI Hero'),
				url: z.literal('https://www.aihero.dev'),
			})
			.strict(),
		offers: offerSchema.optional(),
		hasCourseInstance: z
			.object({
				'@type': z.literal('CourseInstance'),
				courseMode: z.literal('online'),
				startDate: z.string().datetime().optional(),
				endDate: z.string().datetime().optional(),
			})
			.strict()
			.optional(),
	})
	.strict()

describe('typed Course JSON-LD', () => {
	it('validates serialized schema-dts Course with legacy empty price fields', () => {
		const data: WithContext<Course> = buildCourseSchema(input)
		expect(
			courseSchema.safeParse(JSON.parse(JSON.stringify(data))).success,
		).toBe(true)
		expect(data.description).toBe('Learn engineering.')
		expect(data.offers).toMatchObject({ price: 247.5, priceCurrency: 'USD' })
		expect(
			buildProductStructuredData({ product, quantityAvailable: 3 }).offers,
		).toMatchObject({ price: 247.5, priceCurrency: 'USD' })
	})
	it('takes the already-loaded single-seat price, never a constant', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 100000 }), (cents) => {
				const price = cents / 100
				expect(
					buildCourseSchema({
						...input,
						product: { price: { unitAmount: price, fields: {} } },
					}).offers,
				).toMatchObject({ price, priceCurrency: 'USD', url: input.url })
			}),
			{ numRuns: 200 },
		)
	})
	it.each([0, null, undefined, NaN, -2])(
		'omits invalid/unknown prices (%s)',
		(unitAmount) => {
			expect(
				buildCourseSchema({
					...input,
					product: { price: { unitAmount, fields: {} } },
				}).offers,
			).toBeUndefined()
		},
	)
	it('keeps Product JSON-LD when inventory is unknown; only its offer is omitted', () => {
		const data = buildProductStructuredData({
			product,
			quantityAvailable: undefined,
		})
		expect(data['@type']).toBe('Product')
		expect(data.offers).toBeUndefined()
		expect(
			buildCourseSchema({ ...input, quantityAvailable: undefined }).offers,
		).toBeUndefined()
		expect(
			buildCourseSchema({ ...input, quantityAvailable: -2 }).offers,
		).toBeUndefined()
		expect(
			buildCourseSchema({ ...input, product: null }).offers,
		).toBeUndefined()
	})
	it('omits empty JSON-LD descriptions', () => {
		expect(buildCourseSchema({ ...input, description: '' })).not.toHaveProperty(
			'description',
		)
		expect(
			buildProductStructuredData({
				product: { ...product, fields: { ...product.fields, description: '' } },
				quantityAvailable: 3,
			}),
		).not.toHaveProperty('description')
	})
	it.each([
		[0, 'SoldOut'],
		[1, 'InStock'],
		[-1, 'InStock'],
	] as const)(
		'uses the page-resolved inventory %s',
		(quantityAvailable, availability) => {
			expect(
				buildCourseSchema({ ...input, quantityAvailable }).offers,
			).toMatchObject({ availability: `https://schema.org/${availability}` })
		},
	)
	it('keeps the enrollment window and omits pre-open/closed offers (C5 Oct 26)', () => {
		const windowed = {
			...input,
			product: {
				...product,
				fields: {
					...product.fields,
					openEnrollment: '2026-10-26T16:00:00Z',
					closeEnrollment: '2026-11-02T17:00:00Z',
				},
			},
		}
		expect(
			buildCourseSchema({ ...windowed, now: new Date('2026-10-16T12:00:00Z') })
				.offers,
		).toBeUndefined()
		expect(
			buildCourseSchema({ ...windowed, now: new Date('2026-11-02T17:00:00Z') })
				.offers,
		).toBeUndefined()
		const open = buildCourseSchema({
			...windowed,
			now: new Date('2026-10-26T16:00:00Z'),
		})
		expect(open.offers).toMatchObject({
			availabilityStarts: '2026-10-26T16:00:00.000Z',
			availabilityEnds: '2026-11-02T17:00:00.000Z',
			availability: 'https://schema.org/InStock',
		})
		expect(courseSchema.safeParse(open).success).toBe(true)
	})
	it('places dates on an online CourseInstance', () => {
		const data = buildCourseSchema({
			...input,
			startsAt: '2026-11-01T12:00:00Z',
			endsAt: '2026-11-03T12:00:00Z',
		})
		expect(data.hasCourseInstance).toEqual({
			'@type': 'CourseInstance',
			courseMode: 'online',
			startDate: '2026-11-01T12:00:00.000Z',
			endDate: '2026-11-03T12:00:00.000Z',
		})
		expect(data).not.toHaveProperty('startDate')
		expect(courseSchema.safeParse(data).success).toBe(true)
	})
})
