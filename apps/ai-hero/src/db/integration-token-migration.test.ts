import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'
import { integrationToken } from './integration-token-schema'

const migration = readFileSync(
	new URL(
		'./migrations/20261026_ai_hero_integration_token.sql',
		import.meta.url,
	),
	'utf8',
)

describe('integration token migration', () => {
	it('is strictly additive and guarded', () => {
		expect(migration.match(/CREATE TABLE/g)).toHaveLength(1)
		expect(migration).toContain(
			'CREATE TABLE IF NOT EXISTS `AI_IntegrationToken`',
		)
		expect(migration).not.toMatch(
			/\b(ALTER|DROP|RENAME|TRUNCATE|UPDATE|DELETE|INSERT)\b/i,
		)
	})
	it('matches every schema column and primary key', () => {
		const config = getTableConfig(integrationToken)
		expect(config.name).toBe('AI_IntegrationToken')
		for (const column of config.columns) {
			expect(migration).toMatch(
				new RegExp(
					`\`${column.name}\` ${column.getSQLType().replace(/[()]/g, '\\$&')} NOT NULL`,
					'i',
				),
			)
		}
		expect(migration).toContain('PRIMARY KEY (`provider`)')
		expect(
			config.columns
				.filter((column) => column.primary)
				.map((column) => column.name),
		).toEqual(['provider'])
	})
})
