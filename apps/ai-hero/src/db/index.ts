import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { mysqlTable } from '@/db/mysql-table'
import { createDatabasePoolCloser } from '@/db/pool-lifecycle'
import { env } from '@/env.mjs'
import {
	type MySqlDatabase,
	type MySqlQueryResultHKT,
} from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2PreparedQueryHKT } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise'

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

type QueryClient = Pool | PoolConnection

const wrappedQueryClients = new WeakSet<QueryClient>()

function preserveQueryResultShape<TClient extends QueryClient>(client: TClient) {
	if (wrappedQueryClients.has(client)) return client
	wrappedQueryClients.add(client)

	const query = client.query.bind(client)
	client.query = (async (...args: unknown[]) => {
		const result = (await Reflect.apply(query, client, args)) as [
			{ affectedRows?: number; insertId?: number } | unknown[],
			unknown[],
		]
		const rowsOrHeader = result[0]

		return Object.assign(result, {
			insertId: Array.isArray(rowsOrHeader)
				? ''
				: String(rowsOrHeader.insertId ?? ''),
			rows: Array.isArray(rowsOrHeader) ? rowsOrHeader : [],
			rowsAffected: Array.isArray(rowsOrHeader)
				? 0
				: (rowsOrHeader.affectedRows ?? 0),
		})
	}) as TClient['query']

	return client
}

const pool = preserveQueryResultShape(
	mysql.createPool({
		uri: env.DATABASE_URL,
		connectionLimit: 2,
		maxIdle: 2,
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
