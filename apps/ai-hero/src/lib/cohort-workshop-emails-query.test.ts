import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import { requestsAnyWorkshop } from './cohort-workshop-emails-sql'
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
