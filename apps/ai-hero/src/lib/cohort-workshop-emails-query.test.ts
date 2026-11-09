import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/emails-query', () => ({ getEmail: vi.fn() }))
vi.mock('@/lib/products-query', () => ({
	getProduct: vi.fn(),
	getProducts: vi.fn(),
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { requestsAnyWorkshop } = await import('./cohort-workshop-emails-query')

describe('requestsAnyWorkshop', () => {
	it('filters contentIds in SQL with one bound JSON array', () => {
		const ids = ['sync_workshop_a', 'sync_workshop_b']
		const query = new MySqlDialect().sqlToQuery(requestsAnyWorkshop(ids))

		expect(query.sql).toContain('JSON_OVERLAPS(JSON_EXTRACT(')
		expect(query.sql).toContain("'$.contentIds'")
		expect(query.sql).toContain('CAST(? AS JSON)')
		expect(query.params).toEqual([JSON.stringify(ids)])
	})
})
