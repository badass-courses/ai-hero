import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import { ccCreditAllocation, ccCreditReservation } from './cc-credit-schema'

const migration = readFileSync(
	new URL('./migrations/20261028_ai_hero_cc_credit.sql', import.meta.url),
	'utf8',
)
const executable = migration.replace(/^--.*$/gm, '').trim()
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const tables = [
	['reservation', ccCreditReservation],
	['allocation', ccCreditAllocation],
] as const

describe('Crash Course credit schema-only prerequisite', () => {
	it('only creates two existence-guarded tables, without modifying existing data/schema', () => {
		expect(executable.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2)
		expect(executable.split(';').filter((part) => part.trim())).toHaveLength(2)
		expect(executable).not.toMatch(
			/\b(ALTER|DROP|RENAME|TRUNCATE|INSERT|UPDATE|DELETE|REFERENCES|TRIGGER)\b/i,
		)
		expect(executable.match(/COLLATE utf8mb4_bin/g)).toHaveLength(2)
	})

	it.each(tables)(
		'matches every Drizzle column and index: %s',
		(_name, table) => {
			const config = getTableConfig(table)
			const ddl = executable
				.split(';')
				.find((statement) => statement.includes(`\`${config.name}\``))!
			expect(ddl).toBeDefined()
			const columnLines = ddl.split('\n').filter((line) => /^\s+`/.test(line))
			expect(columnLines).toHaveLength(config.columns.length)
			for (const column of config.columns) {
				expect(ddl).toMatch(
					new RegExp(
						`\`${column.name}\` ${escape(column.getSQLType())} ${column.notNull ? 'NOT NULL' : 'NULL'}(?:,|\\n)`,
						'i',
					),
				)
			}
			for (const { config: index } of config.indexes) {
				expect(ddl).toContain(
					`KEY \`${index.name}\` (${index.columns.map((col) => `\`${'name' in col ? col.name : ''}\``).join(', ')})`,
				)
			}
			expect(ddl.match(/\bKEY `/g)).toHaveLength(config.indexes.length)
			const primaryColumns = [
				...config.columns.filter((col) => col.primary),
				...config.primaryKeys.flatMap((pk) => pk.columns),
			]
			expect(ddl).toContain(
				`PRIMARY KEY (${primaryColumns.map((col) => `\`${col.name}\``).join(', ')})`,
			)
		},
	)

	it('makes invoice identity unique while preserving one allocation per source purchase', () => {
		expect(ccCreditReservation.invoiceId.primary).toBe(true)
		const config = getTableConfig(ccCreditAllocation)
		expect(config.primaryKeys[0]!.columns.map((column) => column.name)).toEqual(
			['invoiceId', 'purchaseId'],
		)
		expect(ccCreditReservation.status.enumValues).toEqual([
			'reserved',
			'paid',
			'released',
		])
		// Both tables must be visible to app schema generation once applied.
		expect(
			readFileSync(new URL('./schema.ts', import.meta.url), 'utf8'),
		).toContain(
			"export { ccCreditReservation, ccCreditAllocation } from './cc-credit-schema'",
		)
	})
})
