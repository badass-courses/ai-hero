import { readFileSync } from 'node:fs'

import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import { drovrOutbox } from './schema'

const migration = readFileSync(
	new URL('./migrations/20260930_ai_hero_drovr_outbox.sql', import.meta.url),
	'utf8',
)

describe('the drovr outbox migration (row 204)', () => {
	it('is strictly additive: one guarded CREATE TABLE and nothing else', () => {
		expect(migration.match(/CREATE TABLE/g)).toHaveLength(1)
		expect(migration).toContain('CREATE TABLE `AI_DrovrOutbox`')
		expect(migration).toContain("TABLE_NAME = 'AI_DrovrOutbox'")
		expect(migration).not.toMatch(/\bALTER\b|\bDROP\b|\bRENAME\b|\bTRUNCATE\b/i)
		expect(migration).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/)
	})

	it('declares every schema column and index the app reads', () => {
		const config = getTableConfig(drovrOutbox)
		expect(config.name).toBe('AI_DrovrOutbox')
		for (const column of config.columns) {
			const nullness = column.notNull ? 'NOT NULL' : 'NULL'
			expect(migration).toMatch(
				new RegExp(
					`\`${column.name}\` ${column.getSQLType().replace(/[()]/g, '\\$&')}(?: ${nullness}| ${nullness} DEFAULT)`,
					'i',
				),
			)
		}
		expect(migration).toContain(
			'UNIQUE KEY `DrovrOutbox_dedupe_uq` (`dedupeKey`)',
		)
		expect(migration).toContain(
			'KEY `DrovrOutbox_due_idx` (`status`, `target`, `nextAttemptAt`)',
		)
		expect(migration).toContain(
			'KEY `DrovrOutbox_delivered_idx` (`status`, `deliveredAt`)',
		)
		const indexNames = config.indexes.map((index) => index.config.name)
		expect(indexNames.sort()).toEqual([
			'DrovrOutbox_dedupe_uq',
			'DrovrOutbox_delivered_idx',
			'DrovrOutbox_due_idx',
		])
	})
})
