import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { Effect } from 'effect'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/db/evergreen-offer-journey-schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import { couponExecutorFixture } from './coupon-executor.fixtures'

const url = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!url)
integration('coupon executor guarded durable integration', () => {
	let server: mysql.Connection
	let pool: mysql.Pool
	let name: string
	let real: Parameters<typeof couponExecutorFixture>[0]
	beforeAll(async () => {
		const parsed = new URL(validateMySqlIntegrationServerUrl(url!))
		server = await mysql.createConnection({
			uri: parsed.toString(),
			multipleStatements: true,
		})
		name = `aih_coupon_executor_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		await server.query(`USE \`${name}\``)
		for (const migration of [
			'20260831_ai_hero_email_course_evergreen_schema.sql',
			'20260907_evergreen_admission_attempts.sql',
		])
			await server.query(
				await fs.readFile(
					new URL(`../../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		parsed.pathname = `/${name}`
		pool = preserveQueryResultShape(
			mysql.createPool({
				uri: parsed.toString(),
				timezone: 'Z',
				connectionLimit: 4,
			}),
		)
		const database = drizzle(pool, { schema, mode: 'planetscale' })
		real = {
			ledger: createDrizzleJourneyLedger(database),
			attempts: createDrizzleJourneyAttempts(database),
		}
	})
	beforeEach(async () => {
		for (const table of [
			'AI_EvergreenOfferJourneyAttempt',
			'AI_EvergreenOfferJourneyWake',
			'AI_EvergreenOfferJourneyIntent',
			'AI_EvergreenOfferJourneyCommit',
		])
			await server.query(`DELETE FROM \`${table}\``)
	})
	afterAll(async () => {
		await pool?.end()
		if (name) await server?.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})
	it.each(['issue', 'bind'] as const)(
		'durably claims %s once under concurrent executors',
		async (kind) => {
			const f = await couponExecutorFixture(real)
			const intent = kind === 'bind' ? await f.prepareBinding() : f.issue
			const before = f.state.mutations
			const request = {
				journeyId: intent.journeyId,
				idempotencyKey: intent.idempotencyKey,
			}
			const results = await Promise.all(
				[1, 2].map(() => Effect.runPromise(f.executor.execute(request))),
			)
			expect(f.state.mutations - before).toBe(1)
			expect(results.some((result) => result.type === 'Committed')).toBe(true)
		},
	)
	it('recovers accepted attempt before domain commit without commerce replay', async () => {
		const f = await couponExecutorFixture(real)
		f.state.failDomain = true
		expect((await Effect.runPromise(f.executor.execute(f.request))).type).toBe(
			'Failed',
		)
		f.state.failDomain = false
		const recovered = await Effect.runPromise(
			f.executor.recoverRecordedPage({ now: new Date(f.getNow()), limit: 1 }),
		)
		expect(recovered.results[0]?.type).toBe('Committed')
		expect(f.state.mutations).toBe(1)
		expect(
			(
				await Effect.runPromise(
					f.executor.recoverRecordedPage({
						now: new Date(f.getNow()),
						limit: 1,
					}),
				)
			).scanned,
		).toBe(0)
	})
})
