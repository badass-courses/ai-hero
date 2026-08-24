import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { createDatabasePoolCloser } from '@/db/pool-lifecycle'
import { env } from '@/env.mjs'
import {
	type MySqlDatabase,
	type MySqlQueryResultHKT,
} from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2PreparedQueryHKT } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

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
		connectionLimit: 2,
		maxIdle: 2,
		timezone: 'Z',
		enableKeepAlive: true,
	}),
)
const getConnection = pool.getConnection.bind(pool)
pool.getConnection = (async () =>
	preserveQueryResultShape(await getConnection())) as typeof pool.getConnection

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

export const courseBuilderAdapter = DrizzleAdapter<
	MySqlDatabase<any, any, any>
>(db, mysqlTable, stripeProvider)
