import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { c5SignedPlaybackInventoryQuery } from './c5-signed-playback-inventory'

describe('C5 inventory scope', () => {
	it('binds only the pilot cohort and excludes free, public, and deleted branches', () => {
		const query = new MySqlDialect().sqlToQuery(c5SignedPlaybackInventoryQuery())
		expect(query.params).toEqual(['cohort-xdy1m'])
		expect(query.sql).toContain("AND type = 'cohort' AND deletedAt IS NULL")
		expect(query.sql).toContain("COALESCE(edge.metadata->>'$.tier', '') <> 'free'")
		expect(query.sql).toContain("COALESCE(child.fields->>'$.visibility', '') <> 'public'")
		expect(query.sql).toContain('edge.deletedAt IS NULL')
		expect(query.sql).toContain('child.deletedAt IS NULL')
		expect(query.sql).toContain('tree.depth < 8')
		expect(query.sql).toContain('tree.lessonId IS NOT NULL AND tree.workshopId IS NOT NULL')
	})
})
