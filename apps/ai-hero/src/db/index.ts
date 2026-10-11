import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { createDatabasePoolCloser } from '@/db/pool-lifecycle'
import { env } from '@/env.mjs'
import { guardLegendGiftCouponPaths } from '@/lib/legend-gift-coupon-guard'
import {
	type MySqlDatabase,
	type MySqlQueryResultHKT,
} from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2PreparedQueryHKT } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import type { RequiredPricingAuthority } from '@coursebuilder/commerce/types'
import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import * as schema from './schema'

type TcpQueryResult = {
	insertId: string
	rows: Record<string, any>[]
	rowsAffected: number
}

interface TcpQueryResultHKT extends MySqlQueryResultHKT {
	readonly type: TcpQueryResult
}

const pool = preserveQueryResultShape(
	mysql.createPool({
		uri: env.DATABASE_URL,
		// Serverless keeps this tiny; one-off scripts raise it per run.
		connectionLimit: Number(process.env.DATABASE_POOL_SIZE) || 2,
		maxIdle: Number(process.env.DATABASE_POOL_SIZE) || 2,
		timezone: 'Z',
		enableKeepAlive: true,
	}),
)
const getConnection = pool.getConnection.bind(pool)
pool.getConnection = (async () =>
	preserveQueryResultShape(await getConnection())) as typeof pool.getConnection

/** Existing pool capabilities for owned transactions and independent readback.
 * These do not create another pool or change normal application queries. */
export const acquireDatabaseConnection = () => pool.getConnection()
export const createDatabaseHandle = <Tables extends Record<string, unknown>>(
	tables: Tables,
) => drizzle(pool, { schema: tables, mode: 'planetscale' })

/** Close the app-owned MySQL pool after a finite CLI command completes. */
export const closeDatabasePool = createDatabasePoolCloser(pool)

export const db = drizzle(pool, {
	schema,
	mode: 'planetscale',
}) as unknown as MySqlDatabase<
	TcpQueryResultHKT,
	MySql2PreparedQueryHKT,
	typeof schema
>

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type DbExecutor = typeof db | DbTransaction

const drizzleAdapter = guardLegendGiftCouponPaths(DrizzleAdapter<MySqlDatabase<any, any, any>>(
	db,
	mysqlTable,
	stripeProvider,
))

/**
 * The app's Course Builder adapter. It carries Course Builder's authoritative-price
 * hook, typed `RequiredPricingAuthority`, so a commerce path without the hook
 * does not compile. The hook prices Cohort 005 in-process and returns `null`
 * for every other product, which keeps Course Builder's legacy pricing. It is
 * attached to the adapter object itself, so Course Builder's receivers stay
 * as they were, and loaded on first call to keep `@/db` free of an import
 * cycle.
 */
export const courseBuilderAdapter: RequiredPricingAuthority<
	typeof drizzleAdapter
> = Object.assign(drizzleAdapter, {
	authoritativePrice: async (request: AuthoritativePriceRequest) =>
		(await import('@/lib/c5-pricing/server')).c5AuthoritativePrice(request),
})
