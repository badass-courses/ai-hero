import { readFileSync } from 'node:fs'

import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'

import { deviceAccessToken, shortlinkClick } from './schema'

const migration = readFileSync(
	new URL(
		'./migrations/20260922_ai_hero_analytics_reliability.sql',
		import.meta.url,
	),
	'utf8',
)

const shortlinkClickIndexName = 'ShortlinkClick_timestamp_shortlinkId_idx'

describe('analytics reliability database repair', () => {
	it('keeps the app index declaration and migration column order aligned', () => {
		const config = getTableConfig(shortlinkClick)
		const index = config.indexes.find(
			(candidate) => candidate.config.name === shortlinkClickIndexName,
		)

		if (!index) throw new Error('shortlink click index is missing from schema')

		expect(
			index.config.columns.map((column) =>
				'name' in column ? column.name : undefined,
			),
		).toEqual(['timestamp', 'shortlinkId'])
		expect(migration).toContain(
			'ALTER TABLE `AI_ShortlinkClick` ADD INDEX `ShortlinkClick_timestamp_shortlinkId_idx` (`timestamp`, `shortlinkId`)',
		)
	})

	it('adds each nullable adapter token column with its installed SQL type', () => {
		const config = getTableConfig(deviceAccessToken)
		expect(config.name).toBe('AI_DeviceAccessToken')

		const columns = [
			['scope', 'organizationMembershipId'],
			['expiresAt', 'createdAt'],
			['revokedAt', 'expiresAt'],
		] as const

		for (const [name, after] of columns) {
			const column = config.columns.find((candidate) => candidate.name === name)
			if (!column) throw new Error(`adapter column is missing: ${name}`)

			expect(column.notNull).toBe(false)
			expect(column.hasDefault).toBe(false)
			expect(migration).toContain(
				`ALTER TABLE \`AI_DeviceAccessToken\` ADD COLUMN \`${name}\` ${column.getSQLType()} NULL AFTER \`${after}\``,
			)
			expect(migration).toContain(`COLUMN_NAME = '${name}'`)
		}

		expect(migration).not.toMatch(/CREATE TABLE `AI_DeviceAccessToken`/)
		expect(migration).not.toMatch(/DROP (?:COLUMN|INDEX)/i)
	})
})
