/** Read only. Plans the learning/progress surface's queries on a real database.
 * Database reads must use aihero-support/tmp/db/reader.cjs (reader ACL).
 * Usage from apps/ai-hero:
 * SKIP_ENV_VALIDATION=1 tsx scripts/learning-progress-explain.ts --reader /absolute/path/to/aihero-support/tmp/db/reader.cjs product-s00zs product-ma254
 * Runs the same reads as one cache miss per product. The two aggregates run
 * under EXPLAIN ANALYZE, which executes them once and reports actual rows.
 * Output is plans and aggregate counts; no learner identifiers.
 */
import { createRequire } from 'node:module'
import { isAbsolute, normalize } from 'node:path'
import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import mysql from 'mysql2/promise'

import { readLearningProgress } from '../src/lib/analytics/learning-progress-query'

type ReaderConnection = {
	query(sql: string): Promise<[unknown, unknown]>
	end(): Promise<void>
}

async function main() {
	const [flag, readerPath, ...productIds] = process.argv.slice(2)
	if (
		flag !== '--reader' ||
		!readerPath ||
		!isAbsolute(readerPath) ||
		!normalize(readerPath).endsWith('/aihero-support/tmp/db/reader.cjs') ||
		productIds.length === 0
	) {
		throw new Error('usage: --reader <reader.cjs> <productId>...')
	}
	const reader: () => Promise<ReaderConnection> = createRequire(
		import.meta.url,
	)(readerPath)
	const database = await reader()
	const dialect = new MySqlDialect()
	const inline = (query: SQL) => {
		const { sql, params } = dialect.sqlToQuery(query)
		return mysql.format(sql, params as Parameters<typeof mysql.format>[1])
	}
	try {
		for (const productId of productIds) {
			const plans: { query: string; ms: number; plan?: string }[] = []
			const started = Date.now()
			const result = await readLearningProgress(
				async (query) => {
					const text = inline(query)
					const aggregate =
						/AS teamSeatsUnredeemed|AI_ResourceProgress rp\s+WHERE rp\.resourceId IN/.test(
							text,
						)
					const at = Date.now()
					if (aggregate) {
						const [plan] = (await database.query(
							`EXPLAIN ANALYZE ${text}`,
						)) as [Array<Record<string, string>>, unknown]
						plans.push({
							query: /teamSeatsUnredeemed/.test(text) ? 'roster' : 'progress',
							ms: Date.now() - at,
							plan: Object.values(plan[0] ?? {})[0],
						})
					}
					const rows = await database.query(text)
					if (!aggregate)
						plans.push({ query: 'structure', ms: Date.now() - at })
					return rows
				},
				productId,
				new Date(),
			)
			console.log(
				JSON.stringify({
					productId,
					totalMs: Date.now() - started,
					roster: result.roster,
					funnelRows: result.funnel.rows.length,
					activity: result.activity,
				}),
			)
			for (const entry of plans) {
				console.log(`\n-- ${entry.query} (${entry.ms}ms)`)
				if (entry.plan) console.log(entry.plan)
			}
		}
	} finally {
		await database.end()
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})
