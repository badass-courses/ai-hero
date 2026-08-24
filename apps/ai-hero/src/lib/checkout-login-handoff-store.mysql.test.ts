import fs from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'

import { closeDatabasePool, db as productionDatabase } from '@/db'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import type { CheckoutLoginHandoffPayload } from '@/lib/checkout-login-handoff'
import { createCheckoutLoginHandoffStore } from '@/lib/checkout-login-handoff-store'

const mysqlUrl = process.env.AIH_MYSQL_TEST_URL
const integration = describe.skipIf(!mysqlUrl)
const issuedAt = new Date('2026-08-19T12:00:00.000Z')

function payload({
	nonce,
	expiresAt = new Date('2026-08-19T12:10:00.000Z'),
	pppSelected = true,
}: {
	nonce: string
	expiresAt?: Date
	pppSelected?: boolean
}): CheckoutLoginHandoffPayload {
	return {
		version: 1,
		country: 'TR',
		pppSelected,
		productId: 'product_ai_coding_crash_course',
		quantity: 1,
		issuedAt: issuedAt.getTime(),
		expiresAt: expiresAt.getTime(),
		nonce,
	}
}

function createConnection(uri: string) {
	const pool = preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 1, timezone: 'Z' }),
	)
	const database = drizzle(pool, {
		schema,
		mode: 'planetscale',
	}) as unknown as typeof productionDatabase
	return { pool, store: createCheckoutLoginHandoffStore(database) }
}

integration('checkout login handoff MySQL store', () => {
	let adminPool: Pool
	let first: ReturnType<typeof createConnection>
	let second: ReturnType<typeof createConnection>

	beforeAll(async () => {
		adminPool = mysql.createPool({
			uri: mysqlUrl!,
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		await adminPool.query('DROP TABLE IF EXISTS `AI_CheckoutLoginHandoff`')
		const migration = await fs.readFile(
			new URL(
				'../db/migrations/20260819_ai_hero_checkout_login_handoff.sql',
				import.meta.url,
			),
			'utf8',
		)
		await adminPool.query(migration)
		first = createConnection(mysqlUrl!)
		second = createConnection(mysqlUrl!)
	})

	beforeEach(async () => {
		await adminPool.query('DELETE FROM `AI_CheckoutLoginHandoff`')
	})

	afterAll(async () => {
		await first.pool.end()
		await second.pool.end()
		await adminPool.query('DROP TABLE IF EXISTS `AI_CheckoutLoginHandoff`')
		await adminPool.end()
		await closeDatabasePool()
	})

	it('races separate connections, completes once, and returns the exact receipt', async () => {
		const handoff = payload({ nonce: 'mysql-race' })
		const nonceHash = 'a'.repeat(64)
		const browserSessionHash = 'b'.repeat(64)
		await first.store.issue({
			nonceHash,
			browserSessionHash,
			payload: handoff,
			now: issuedAt,
		})

		const [persisted] = (await adminPool.query(
			'SELECT `issuedAt`, `expiresAt`, `pppSelected` FROM `AI_CheckoutLoginHandoff` WHERE `nonceHash` = ?',
			[nonceHash],
		)) as unknown as [
			Array<{ issuedAt: Date; expiresAt: Date; pppSelected: number }>,
			unknown,
		]
		expect(persisted[0]?.issuedAt.getTime()).toBe(handoff.issuedAt)
		expect(persisted[0]?.expiresAt.getTime()).toBe(handoff.expiresAt)
		expect(persisted[0]?.pppSelected).toBe(1)

		const claims = await Promise.all([
			first.store.claim({
				nonceHash,
				browserSessionHash,
				payload: handoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:01.000Z'),
			}),
			second.store.claim({
				nonceHash,
				browserSessionHash,
				payload: handoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:01.000Z'),
			}),
		])
		const acquired = claims.filter((claim) => claim.kind === 'acquired')
		expect(acquired).toHaveLength(1)
		expect(claims.filter((claim) => claim.kind === 'replayed')).toHaveLength(1)
		if (acquired[0]?.kind !== 'acquired') throw new Error('claim not acquired')

		expect(
			await first.store.complete({
				claim: acquired[0].claim,
				receipt: {
					providerSessionId: 'cs_test_mysql',
					redirect: 'https://checkout.stripe.com/c/pay/cs_test_mysql',
				},
				now: new Date('2026-08-19T12:00:02.000Z'),
			}),
		).toBe(true)
		expect(
			await second.store.claim({
				nonceHash,
				browserSessionHash,
				payload: handoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:03.000Z'),
			}),
		).toEqual({
			kind: 'completed',
			receipt: {
				providerSessionId: 'cs_test_mysql',
				redirect: 'https://checkout.stripe.com/c/pay/cs_test_mysql',
			},
		})
	})

	it('keeps retry and stale-claim recovery bound to the same user and browser', async () => {
		const handoff = payload({ nonce: 'mysql-retry' })
		const nonceHash = 'c'.repeat(64)
		const browserSessionHash = 'd'.repeat(64)
		await first.store.issue({
			nonceHash,
			browserSessionHash,
			payload: handoff,
			now: issuedAt,
		})
		const claimed = await first.store.claim({
			nonceHash,
			browserSessionHash,
			payload: handoff,
			userId: 'user_mysql',
			now: new Date('2026-08-19T12:00:01.000Z'),
		})
		if (claimed.kind !== 'acquired') throw new Error('claim not acquired')
		expect(
			await second.store.claim({
				nonceHash,
				browserSessionHash: 'e'.repeat(64),
				payload: handoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:02.000Z'),
			}),
		).toEqual({ kind: 'browser-mismatch' })
		expect(
			await second.store.claim({
				nonceHash,
				browserSessionHash,
				payload: handoff,
				userId: 'other_user',
				now: new Date('2026-08-19T12:00:02.000Z'),
			}),
		).toEqual({ kind: 'user-mismatch' })

		expect(await first.store.failRetryable({ claim: claimed.claim })).toBe(true)
		expect(
			await second.store.claim({
				nonceHash,
				browserSessionHash,
				payload: handoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:03.000Z'),
			}),
		).toMatchObject({ kind: 'acquired' })

		const staleHandoff = payload({ nonce: 'mysql-stale' })
		const staleHash = 'f'.repeat(64)
		await first.store.issue({
			nonceHash: staleHash,
			browserSessionHash,
			payload: staleHandoff,
			now: issuedAt,
		})
		expect(
			await first.store.claim({
				nonceHash: staleHash,
				browserSessionHash,
				payload: staleHandoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:01.000Z'),
			}),
		).toMatchObject({ kind: 'acquired' })
		expect(
			await second.store.claim({
				nonceHash: staleHash,
				browserSessionHash,
				payload: staleHandoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:32.000Z'),
			}),
		).toMatchObject({ kind: 'acquired' })
	})

	it('rejects an expired persisted handoff', async () => {
		const handoff = payload({
			nonce: 'mysql-expired',
			expiresAt: new Date('2026-08-19T12:00:05.000Z'),
		})
		const nonceHash = '1'.repeat(64)
		const browserSessionHash = '2'.repeat(64)
		await first.store.issue({
			nonceHash,
			browserSessionHash,
			payload: handoff,
			now: issuedAt,
		})
		expect(
			await second.store.claim({
				nonceHash,
				browserSessionHash,
				payload: handoff,
				userId: 'user_mysql',
				now: new Date('2026-08-19T12:00:06.000Z'),
			}),
		).toEqual({ kind: 'expired' })
	})
})
