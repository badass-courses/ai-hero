import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = {
	id: string
	status: number
	fields: Record<string, unknown> | null
	[key: string]: unknown
}

const mocks = vi.hoisted(() => ({
	rows: [] as Row[],
	cacheCalls: [] as Array<{ keyParts: string[]; options: any }>,
	revalidateTag: vi.fn(),
}))

vi.mock('next/cache', () => ({
	unstable_cache: (fn: unknown, keyParts: string[], options: unknown) => {
		mocks.cacheCalls.push({ keyParts, options })
		return fn
	},
	revalidateTag: mocks.revalidateTag,
}))
vi.mock('drizzle-orm', () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
}))
vi.mock('@/db/schema', () => ({
	products: { status: 'status' },
}))
// A fake that honours what the query asks for: the `where` filter and the
// `columns` projection. A query that drops the status filter or reads every
// column shows up in the result.
vi.mock('@/db', () => ({
	db: {
		query: {
			products: {
				findMany: vi.fn(
					async ({
						where,
						columns,
					}: {
						where?: { column: string; value: unknown }
						columns?: Record<string, boolean>
					}) =>
						mocks.rows
							.filter((row) => !where || row[where.column] === where.value)
							.map((row) =>
								columns
									? Object.fromEntries(
											Object.keys(columns)
												.filter((key) => columns[key])
												.map((key) => [key, row[key]]),
										)
									: { ...row },
							),
				),
			},
		},
	},
}))

import { db } from '@/db'

import { revalidateProducts } from './product-cache'
import {
	getActiveProductSlugMap,
	loadActiveProductSlugEntries,
	PRODUCT_SLUG_MAP_TAGS,
	toProductSlugMap,
} from './product-slug-map'

// The cohort page's map before the cache: every active product row, keyed by
// `fields.slug`. Its one `undefined` key (products with no slug) could never
// be looked up, since `HasPurchased` only reads the map with a slug in hand.
function oldProductMap(rows: Row[]) {
	const active = rows.filter((row) => row.status === 1)
	const map = new Map(active.map((p) => [(p.fields as any)?.slug, p.id]))
	map.delete(undefined)
	return map
}

// `unstable_cache` stores JSON, so the page reads back what survives a
// round-trip, not the object the loader returned.
const throughCache = <T>(value: T): T => JSON.parse(JSON.stringify(value))

beforeEach(() => {
	mocks.rows = []
	mocks.revalidateTag.mockClear()
})

describe('active product slug map', () => {
	it('maps slug to id for active products and leaves inactive ones out', async () => {
		mocks.rows = [
			{ id: 'p1', status: 1, fields: { slug: 'crash-course', body: 'x' } },
			{ id: 'p2', status: 0, fields: { slug: 'archived-course' } },
			{ id: 'p3', status: 1, fields: { slug: 'workshop' } },
		]

		const map = await getActiveProductSlugMap()

		expect([...map]).toEqual([
			['crash-course', 'p1'],
			['workshop', 'p3'],
		])
		expect(map.has('archived-course')).toBe(false)
	})

	it('caches only id and slug, never the rest of the product', async () => {
		mocks.rows = [
			{
				id: 'p1',
				status: 1,
				name: 'Crash Course',
				fields: { slug: 'crash-course', body: 'long body', state: 'published' },
			},
		]

		expect(await loadActiveProductSlugEntries()).toEqual([
			{ id: 'p1', slug: 'crash-course' },
		])
		// The database sends two columns, not the whole row.
		expect(db.query.products.findMany).toHaveBeenLastCalledWith(
			expect.objectContaining({ columns: { id: true, fields: true } }),
		)
	})

	it('is tagged `products` with a short backstop, and product writes revalidate that tag', () => {
		const call = mocks.cacheCalls.find((c) =>
			c.keyParts.includes('active-product-slug-map-v1'),
		)
		expect(call?.options).toEqual({ revalidate: 300, tags: ['products'] })
		expect(PRODUCT_SLUG_MAP_TAGS).toEqual(['products'])

		revalidateProducts()

		expect(mocks.revalidateTag).toHaveBeenCalledWith('products', 'max')
	})

	it('builds the same map as the old full-row query for any product set', async () => {
		const slug = fc.option(
			fc.constantFrom('crash-course', 'workshop', 'cohort-5', 'bundle', ''),
			{ nil: undefined },
		)
		const row = fc.record({
			id: fc.uuid(),
			status: fc.constantFrom(0, 1, 2),
			fields: fc.oneof(
				fc.constant(null),
				fc.record(
					{ slug, state: fc.string(), body: fc.string() },
					{ requiredKeys: [] },
				),
			),
		})

		await fc.assert(
			fc.asyncProperty(fc.array(row, { maxLength: 12 }), async (rows) => {
				mocks.rows = rows
				const entries = throughCache(await loadActiveProductSlugEntries())
				expect([...toProductSlugMap(entries)]).toEqual([
					...oldProductMap(rows),
				])
			}),
		)
	})
})
