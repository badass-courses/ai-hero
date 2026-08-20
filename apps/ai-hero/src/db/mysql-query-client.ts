import type { Pool, PoolConnection } from 'mysql2/promise'

type QueryClient = Pool | PoolConnection

const wrappedQueryClients = new WeakSet<QueryClient>()

/**
 * Keeps mysql2 tuple results while exposing the PlanetScale-style fields the
 * production Drizzle result type reads for affected-row decisions.
 */
export function preserveQueryResultShape<TClient extends QueryClient>(
	client: TClient,
) {
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
