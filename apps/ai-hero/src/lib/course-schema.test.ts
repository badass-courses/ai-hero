import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Course, WithContext } from 'schema-dts'
import { z } from 'zod'
import { buildCourseSchema } from './course-schema'

const input = {
	title: 'Synthetic course',
	description: 'Learn *engineering*.',
	url: 'https://www.aihero.dev/workshops/synthetic-course',
	product: {
		price: {
			unitAmount: 247.5,
			fields: { stripe: { currency: 'gbp', active: true, supported: true } },
		},
	},
	quantityAvailable: 3,
}
const offerSchema = z
	.object({
		'@type': z.literal('Offer'),
		price: z.number().positive(),
		priceCurrency: z.string().regex(/^[A-Z]{3}$/),
		availability: z.enum([
			'https://schema.org/InStock',
			'https://schema.org/SoldOut',
		]),
		url: z.string().url(),
	})
	.strict()
const courseSchema = z
	.object({
		'@context': z.literal('https://schema.org'),
		'@type': z.literal('Course'),
		name: z.string().min(1),
		description: z.string(),
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
	it('validates a serialized schema-dts Course against JSON-LD field constraints', () => {
		const data: WithContext<Course> = buildCourseSchema(input)
		expect(
			courseSchema.safeParse(JSON.parse(JSON.stringify(data))).success,
		).toBe(true)
		expect(data.description).toBe('Learn engineering.')
	})
	it('takes single-seat list price and currency from the loaded product, never a constant', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 100000 }), (cents) => {
				const price = cents / 100
				const data = buildCourseSchema({
					...input,
					product: { price: { ...input.product.price, unitAmount: price } },
				})
				expect(data.offers).toMatchObject({
					price,
					priceCurrency: 'GBP',
					url: input.url,
				})
			}),
			{ numRuns: 200 },
		)
	})
	it.each([0, null, undefined, NaN, -2])(
		'omits unknown/invalid prices, never emits 0 (%s)',
		(unitAmount) => {
			expect(
				buildCourseSchema({
					...input,
					product: { price: { ...input.product.price, unitAmount } },
				}).offers,
			).toBeUndefined()
		},
	)
	it('omits offers without a known currency or stock reading', () => {
		expect(
			buildCourseSchema({ ...input, product: { price: { unitAmount: 199 } } })
				.offers,
		).toBeUndefined()
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
	it.each([
		[0, 'SoldOut'],
		[1, 'InStock'],
		[-1, 'InStock'],
	] as const)(
		'uses shared resolved inventory %s',
		(quantityAvailable, availability) => {
			expect(
				buildCourseSchema({ ...input, quantityAvailable }).offers,
			).toMatchObject({ availability: `https://schema.org/${availability}` })
		},
	)
	it('places dates on an online CourseInstance, not Course', () => {
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
