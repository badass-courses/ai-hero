import { preserveQueryResultShape } from './mysql-query-client'
import { createDatabasePoolCloser } from './pool-lifecycle'
import {
	type MySqlDatabase,
	type MySqlQueryResultHKT,
} from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2PreparedQueryHKT } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import * as schema from './schema'

type TcpQueryResult = {
	insertId: string
	rows: Record<string, any>[]
	rowsAffected: number
}

interface TcpQueryResultHKT extends MySqlQueryResultHKT {
	readonly type: TcpQueryResult
}

// Ops commands need only the database configuration, not the app's secret schema.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl?.trim()) {
	throw new Error('Missing required environment variable: DATABASE_URL')
}
const poolSizeValue = process.env.DATABASE_POOL_SIZE
const poolSize = poolSizeValue === undefined ? 2 : Number(poolSizeValue)
if (
	(poolSizeValue !== undefined && !/^[1-9]\d*$/.test(poolSizeValue)) ||
	!Number.isSafeInteger(poolSize) ||
	poolSize <= 0
) {
	throw new Error('DATABASE_POOL_SIZE must be a positive integer')
}

const pool = preserveQueryResultShape(
	mysql.createPool({
		uri: databaseUrl,
		// Serverless keeps this tiny; one-off scripts raise it per run.
		connectionLimit: poolSize,
		maxIdle: poolSize,
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
