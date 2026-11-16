import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { and, eq, is, isNull, SQL } from 'drizzle-orm'
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
// The real entitlement writers, without the provider imports the full
// product-type config pulls in.
vi.mock('@/inngest/config/product-types', async () => {
	const { createCohortEntitlement, createWorkshopEntitlement } =
		await import('@/lib/entitlements')
	return {
		PRODUCT_TYPE_CONFIG: {
			cohort: { createEntitlement: createCohortEntitlement },
			'self-paced': { createEntitlement: createWorkshopEntitlement },
		},
	}
})

import { createResourceEntitlements } from './entitlements-query'
import { softDeleteEntitlementsForPurchase } from './entitlements'

const uri = process.env.AIH_ENTITLEMENTS_MYSQL_URL
const suite = uri ? describe : describe.skip
const dialect = new MySqlDialect()

// Disposable DDL from the installed schema, never a production clone.
async function createFixtureSchema(pool: Pool) {
	for (const table of [schema.entitlements]) {
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
		await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

const user = { id: 'user-buyer' }
const workshop = { id: 'workshop-fixture', type: 'workshop', fields: {} }
const cohort = {
	id: 'cohort-fixture',
	resources: [{ resource: { id: 'workshop-in-cohort', type: 'workshop' } }],
}
const context = {
	organizationId: 'org-buyer',
	orgMembership: { id: 'member-buyer' },
	contentAccessEntitlementType: { id: 'type-content' },
}

suite('content entitlements are minted per purchase', () => {
	let pool: Pool

	beforeAll(async () => {
		const parsed = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
			parsed.pathname !== '/entitlements_test'
		)
			throw new Error('Only the loopback entitlements_test fixture is allowed')
		const server = new URL(uri!)
		server.pathname = '/'
		const bootstrap = await mysql.createConnection({ uri: server.toString() })
		await bootstrap.query('CREATE DATABASE IF NOT EXISTS entitlements_test')
		await bootstrap.end()
		pool = preserveQueryResultShape(
			mysql.createPool({ uri: uri!, connectionLimit: 4, timezone: 'Z' }),
		)
		await createFixtureSchema(pool)
		state.database = drizzle(pool, { schema, mode: 'default' })
	})

	beforeEach(async () => {
		await pool.query('DELETE FROM `AI_Entitlement`')
	})

	afterAll(async () => {
		await pool?.end()
	})

	async function liveContent(sourceId: string) {
		const db = state.database as ReturnType<typeof drizzle<typeof schema>>
		return db
			.select()
			.from(schema.entitlements)
			.where(
				and(
					eq(schema.entitlements.sourceId, sourceId),
					eq(schema.entitlements.entitlementType, 'type-content'),
					isNull(schema.entitlements.deletedAt),
				),
			)
	}

	it('gives a second copy of a self-paced product its own content access', async () => {
		await createResourceEntitlements('self-paced', workshop, {
			...context,
			user,
			purchase: { id: 'purch-first' },
		})
		await createResourceEntitlements('self-paced', workshop, {
			...context,
			user,
			purchase: { id: 'purch-second' },
		})

		expect(await liveContent('purch-first')).toHaveLength(1)
		expect(await liveContent('purch-second')).toHaveLength(1)
	})

	it('keeps access after the first copy is refunded', async () => {
		await createResourceEntitlements('cohort', cohort, {
			...context,
			user,
			purchase: { id: 'purch-first' },
		})
		await createResourceEntitlements('cohort', cohort, {
			...context,
			user,
			purchase: { id: 'purch-second' },
		})

		await softDeleteEntitlementsForPurchase('purch-first')

		expect(await liveContent('purch-first')).toHaveLength(0)
		const [row] = await liveContent('purch-second')
		expect(row?.metadata).toMatchObject({ contentIds: ['workshop-in-cohort'] })
	})

	it('does not duplicate when the same purchase is fulfilled twice', async () => {
		for (const _attempt of [1, 2])
			await createResourceEntitlements('self-paced', workshop, {
				...context,
				user,
				purchase: { id: 'purch-retry' },
			})

		expect(await liveContent('purch-retry')).toHaveLength(1)
	})
})
