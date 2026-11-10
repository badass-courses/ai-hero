/** Read only. Plans the learning surfaces' queries on a real database.
 * Database reads must use aihero-support/tmp/db/reader.cjs (reader ACL).
 * Usage from apps/ai-hero:
 * SKIP_ENV_VALIDATION=1 tsx scripts/learning-progress-explain.ts --reader /absolute/path/to/aihero-support/tmp/db/reader.cjs product-s00zs product-ma254
 * Runs the same reads as one cache miss per product, then the team surfaces
 * for every team and for the largest team by current seat holders. Each
 * aggregate runs under EXPLAIN ANALYZE, which executes it once and reports
 * actual rows. Output is plans, timings and counts: member rows stay in
 * memory and are never printed.
 */
import { createRequire } from 'node:module'
import { isAbsolute, normalize } from 'node:path'
import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import mysql from 'mysql2/promise'

import { readLearningProgress } from '../src/lib/analytics/learning-progress-query'
import {
	readLearningTeam,
	readLearningTeamMembers,
	readLearningTeams,
} from '../src/lib/analytics/learning-teams-query'

type ReaderConnection = {
	query(sql: string): Promise<[unknown, unknown]>
	end(): Promise<void>
}

/** Labels for the aggregate reads; anything else is a small structure read. */
const LABELS: Array<[label: string, pattern: RegExp]> = [
	['team rows', /AS purchasedAtMs/],
	['team facts', /AS openCompleted/],
	['team members', /AS workshopsStarted/],
	['roster', /AS teamSeatsUnredeemed/],
	['progress', /AI_ResourceProgress rp\s+WHERE rp\.resourceId IN/],
]

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
	const run = async <T>(
		heading: string,
		read: (execute: (query: SQL) => Promise<unknown>) => Promise<T>,
		summarize: (result: T) => unknown,
	) => {
		const plans: { query: string; ms: number; plan?: string }[] = []
		const started = Date.now()
		const result = await read(async (query) => {
			const text = inline(query)
			const label = LABELS.find(([, pattern]) => pattern.test(text))?.[0]
			const at = Date.now()
			if (label) {
				const [plan] = (await database.query(`EXPLAIN ANALYZE ${text}`)) as [
					Array<Record<string, string>>,
					unknown,
				]
				plans.push({
					query: label,
					ms: Date.now() - at,
					plan: Object.values(plan[0] ?? {})[0],
				})
			}
			const rows = await database.query(text)
			if (!label) plans.push({ query: 'structure', ms: Date.now() - at })
			return rows
		})
		console.log(
			`\n== ${heading}\n${JSON.stringify({ totalMs: Date.now() - started, ...(summarize(result) as object) })}`,
		)
		for (const entry of plans) {
			console.log(`\n-- ${entry.query} (${entry.ms}ms)`)
			if (entry.plan) console.log(entry.plan)
		}
		return result
	}
	try {
		for (const productId of productIds) {
			await run(
				`learning/progress ${productId}`,
				(execute) => readLearningProgress(execute, productId, new Date()),
				(result) => ({
					roster: result.roster,
					funnelRows: result.funnel.rows.length,
					activity: result.activity,
				}),
			)
		}
		const teams = await run(
			'learning/teams (all products)',
			(execute) => readLearningTeams(execute, null, new Date()),
			(result) => ({ teams: result.teams.length }),
		)
		const largest = [...teams.teams].sort(
			(a, b) => b.members.count - a.members.count,
		)[0]
		if (!largest) return
		await run(
			`learning/team ${largest.teamId}`,
			(execute) => readLearningTeam(execute, largest.teamId, new Date()),
			(result) => ({
				product: result.team.product.id,
				seats: result.team.seats,
				members: result.team.members,
			}),
		)
		await run(
			`learning/team-members ${largest.teamId}`,
			(execute) =>
				readLearningTeamMembers(execute, largest.teamId, new Date(), {
					includeUserIds: false,
				}),
			(result) => ({ memberRows: result.members.length }),
		)
	} finally {
		await database.end()
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})
