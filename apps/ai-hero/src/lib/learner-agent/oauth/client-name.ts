import { db } from '@/db'
import {
	deviceAccessTokenClientName,
	informationSchemaColumns,
} from '@/db/device-access-token-client-name-schema'
import { log } from '@/server/logger'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * The client name on a learner token, behind feature detection. The column
 * arrives in its own migration, applied separately; until information_schema
 * shows it, nothing here reads or writes it and tokens list without a name.
 * Seen once, it is trusted for the life of the instance; not seen, it is
 * checked again after five minutes.
 */
const RECHECK_MS = 5 * 60 * 1000
let detected: { ready: boolean; checkedAt: number } | null = null

/** Tests only. */
export const resetClientNameDetection = () => {
	detected = null
}

export async function clientNameColumnReady(): Promise<boolean> {
	if (detected?.ready) return true
	if (detected && Date.now() - detected.checkedAt < RECHECK_MS) return false
	let ready = false
	try {
		const rows = await db
			.select({ name: informationSchemaColumns.columnName })
			.from(informationSchemaColumns)
			.where(
				and(
					eq(informationSchemaColumns.tableSchema, sql`DATABASE()`),
					eq(informationSchemaColumns.tableName, 'AI_DeviceAccessToken'),
					eq(informationSchemaColumns.columnName, 'clientName'),
				),
			)
			.limit(1)
		ready = rows.length > 0
	} catch (error) {
		void log.warn('learner_agent.oauth', {
			outcome: 'client_name_detect_failed',
			error: error instanceof Error ? error.message : String(error),
		})
	}
	detected = { ready, checkedAt: Date.now() }
	return ready
}

/** Names the client on a freshly minted token. Never fails the grant. */
export async function recordClientName(token: string, clientName: string) {
	if (!clientName || !(await clientNameColumnReady())) return
	try {
		await db
			.update(deviceAccessTokenClientName)
			.set({ clientName: clientName.slice(0, 191) })
			.where(eq(deviceAccessTokenClientName.token, token))
	} catch (error) {
		void log.warn('learner_agent.oauth', {
			outcome: 'client_name_write_failed',
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/** Client names for some of a learner's tokens, keyed by raw token. */
export async function clientNamesFor(
	userId: string,
	tokens: ReadonlyArray<string>,
): Promise<Map<string, string>> {
	const names = new Map<string, string>()
	if (tokens.length === 0 || !(await clientNameColumnReady())) return names
	try {
		const rows = await db
			.select({
				token: deviceAccessTokenClientName.token,
				clientName: deviceAccessTokenClientName.clientName,
			})
			.from(deviceAccessTokenClientName)
			.where(
				and(
					eq(deviceAccessTokenClientName.userId, userId),
					inArray(deviceAccessTokenClientName.token, [...tokens]),
				),
			)
		for (const row of rows)
			if (row.clientName) names.set(row.token, row.clientName)
	} catch (error) {
		void log.warn('learner_agent.oauth', {
			outcome: 'client_name_read_failed',
			error: error instanceof Error ? error.message : String(error),
		})
	}
	return names
}
