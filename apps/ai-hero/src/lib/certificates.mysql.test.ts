import { randomUUID } from 'node:crypto'

import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { is, SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

const state = vi.hoisted(() => ({ database: undefined as unknown }))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cohorts-query', () => ({ getAllWorkshopsInCohort: vi.fn() }))

import {
	checkCertificateEligibility,
	checkCohortCertificateEligibilityFromWorkshops,
} from './certificates'
import { validateMySqlIntegrationServerUrl } from './team-purchase-mysql-test-guard'
import type { Workshop } from './workshops'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
const dialect = new MySqlDialect()
const tables = [
	schema.contentResource,
	schema.contentResourceResource,
	schema.resourceProgress,
]

// Disposable DDL from the installed schema, never a production clone.
async function createFixtureSchema(pool: Pool) {
	for (const table of tables) {
		const config = getTableConfig(table)
		const columns = config.columns.map((column) => {
			const fallback =
				column.default === undefined
					? ''
					: column.default === null
						? ' DEFAULT NULL'
						: is(column.default, SQL)
							? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`
							: column.getSQLType() === 'json'
								? ` DEFAULT ('${JSON.stringify(column.default)}')`
								: ` DEFAULT '${String(column.default)}'`
			return `\`${column.name}\` ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${fallback}${column.primary ? ' PRIMARY KEY' : ''}`
		})
		if (!config.columns.some((column) => column.primary))
			for (const key of config.primaryKeys)
				columns.push(
					`PRIMARY KEY (${key.columns.map((column) => `\`${column.name}\``).join(',')})`,
				)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

const USER = 'learner'
const DELETED = '2026-10-10 00:00:00'

integration('certificate eligibility on MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined

	const resourceTable = getTableConfig(schema.contentResource).name
	const linkTable = getTableConfig(schema.contentResourceResource).name
	const progressTable = getTableConfig(schema.resourceProgress).name

	const resource = (
		id: string,
		type: string,
		options: { deletedAt?: string; optional?: boolean } = {},
	) =>
		pool.query(
			`INSERT INTO \`${resourceTable}\` (id, type, createdById, fields, deletedAt) VALUES (?, ?, 'author', ?, ?)`,
			[
				id,
				type,
				JSON.stringify({
					slug: id,
					...(options.optional ? { optional: 'true' } : {}),
				}),
				options.deletedAt ?? null,
			],
		)
	const link = (parent: string, child: string, deletedAt?: string) =>
		pool.query(
			`INSERT INTO \`${linkTable}\` (resourceOfId, resourceId, position, deletedAt) VALUES (?, ?, 0, ?)`,
			[parent, child, deletedAt ?? null],
		)
	const complete = (...lessons: string[]) =>
		Promise.all(
			lessons.map((lesson) =>
				pool.query(
					`INSERT INTO \`${progressTable}\` (userId, resourceId, completedAt) VALUES (?, ?, '2026-11-20 12:00:00')`,
					[USER, lesson],
				),
			),
		)
	const lesson = async (parent: string, id: string) => {
		await resource(id, 'lesson')
		await link(parent, id)
	}
	const earned = async (moduleId: string) =>
		(await checkCertificateEligibility(moduleId, USER)).hasCompletedModule

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_certificates_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = preserveQueryResultShape(
			mysql.createPool({ uri: target.toString(), timezone: 'Z' }),
		)
		const acquire = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(await acquire())) as typeof pool.getConnection
		await createFixtureSchema(pool)
		state.database = drizzle(pool, { schema, mode: 'planetscale' })
	}, 30000)

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		for (const table of [resourceTable, linkTable, progressTable])
			await pool.query(`DELETE FROM \`${table}\``)
		// A workshop with two lessons of its own and one in a section.
		await resource('workshop', 'workshop')
		await lesson('workshop', 'lesson-1')
		await lesson('workshop', 'lesson-2')
		await resource('section', 'section')
		await link('workshop', 'section')
		await lesson('section', 'lesson-3')
	})

	it('is earned when every lesson is done, and not one lesson short', async () => {
		await complete('lesson-1', 'lesson-2')
		expect(await earned('workshop')).toBe(false)
		await complete('lesson-3')
		expect(await earned('workshop')).toBe(true)
	})

	it('finds the module by slug as well as by id', async () => {
		await pool.query(
			`UPDATE \`${resourceTable}\` SET fields = JSON_SET(fields, '$.slug', 'the-workshop') WHERE id = 'workshop'`,
		)
		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect(await earned('the-workshop')).toBe(true)
	})

	it('does not ask for a lesson that was removed from the workshop', async () => {
		await resource('removed', 'lesson')
		await link('workshop', 'removed', DELETED)
		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect(await earned('workshop')).toBe(true)
	})

	it('does not ask for a lesson that was removed from a section', async () => {
		await resource('removed', 'lesson')
		await link('section', 'removed', DELETED)
		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect(await earned('workshop')).toBe(true)
	})

	it('does not ask for the lessons of a section that was removed', async () => {
		await resource('old-section', 'section')
		await link('workshop', 'old-section', DELETED)
		await lesson('old-section', 'old-lesson')
		await resource('gone-section', 'section', { deletedAt: DELETED })
		await link('workshop', 'gone-section')
		await lesson('gone-section', 'gone-lesson')
		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect(await earned('workshop')).toBe(true)
	})

	it('does not ask for a lesson that was itself deleted', async () => {
		await resource('deleted', 'lesson', { deletedAt: DELETED })
		await link('workshop', 'deleted')
		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect(await earned('workshop')).toBe(true)
	})

	it('still skips optional lessons', async () => {
		await resource('extra', 'lesson', { optional: true })
		await link('workshop', 'extra')
		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect(await earned('workshop')).toBe(true)
	})

	it('is never earned for a module with nothing left to complete', async () => {
		await resource('archive', 'workshop')
		await resource('archived-lesson', 'lesson')
		await link('archive', 'archived-lesson', DELETED)
		await resource('empty', 'workshop')
		expect(await earned('archive')).toBe(false)
		expect(await earned('empty')).toBe(false)
	})

	it('earns the cohort certificate across workshops, removed lessons aside', async () => {
		await resource('workshop-2', 'workshop')
		await lesson('workshop-2', 'lesson-4')
		await resource('removed', 'lesson')
		await link('workshop-2', 'removed', DELETED)
		const workshops = [{ id: 'workshop' }, { id: 'workshop-2' }] as Workshop[]
		const cohort = () =>
			checkCohortCertificateEligibilityFromWorkshops(workshops, USER)

		await complete('lesson-1', 'lesson-2', 'lesson-3')
		expect((await cohort()).hasCompletedCohort).toBe(false)
		await complete('lesson-4')
		expect((await cohort()).hasCompletedCohort).toBe(true)
	})
})
