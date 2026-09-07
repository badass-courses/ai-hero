import { createHash, randomUUID } from 'node:crypto'
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
import {
	commerceDdl,
	commerceTables,
	realCommerceFixture,
} from './coupon-executor-commerce.fixtures'
import type { SideEffectIntent } from './domain'

type RealFixture = Awaited<ReturnType<typeof realCommerceFixture>>
type CouponIntent = Extract<
	SideEffectIntent,
	{ type: 'IssueCoupon' | 'BindCoupon' }
>
function settlementId(intent: CouponIntent) {
	const kind = intent.type === 'IssueCoupon' ? 'issued' : 'bound'
	return `coupon-executor:${createHash('sha256').update(`${intent.idempotencyKey}:${kind}`).digest('hex')}`
}
async function recoverWithoutCommerce(
	f: RealFixture,
	intent: CouponIntent,
	recorded = false,
) {
	const before = await f.snapshot()
	const calls = { ...f.calls }
	const original = await f.attempt(intent.idempotencyKey)
	expect(new Date(f.getNow()) > original.leaseExpiresAt).toBe(true)
	f.queries.length = 0
	const page = recorded
		? await Effect.runPromise(
				f.executor.recoverRecordedPage({
					now: new Date(f.getNow()),
					limit: 10,
				}),
			)
		: await Effect.runPromise(
				f.executor.recoverUncertainPage({
					now: new Date(f.getNow()),
					limit: 10,
				}),
			)
	expect(page.results).toHaveLength(1)
	expect(page.results[0]).toMatchObject({
		type: 'Committed',
		mutation: 'NotAttempted',
	})
	expect(f.queries.length).toBeGreaterThan(0)
	expect(
		f.queries.every(
			(query) => /^select\b/i.test(query) && !/for update/i.test(query),
		),
	).toBe(true)
	expect(f.calls).toEqual(calls)
	expect(await f.snapshot()).toEqual(before)
	const saved = await f.attempt(intent.idempotencyKey)
	expect(saved).toMatchObject({
		status: 'Accepted',
		claimToken: original.claimToken,
		claimedAt: original.claimedAt,
		leaseExpiresAt: original.leaseExpiresAt,
	})
	const stimulus = f.stimuli.at(-1)
	if (!stimulus) throw new Error('Missing full domain stimulus')
	expect(
		(
			await Effect.runPromise(
				f.ledger.findCommittedStimulus(stimulus.stimulusId, stimulus),
			)
		)?.committed,
	).toBe(true)
	return { saved, stimulus }
}

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
		for (const statement of commerceDdl) await server.query(statement)
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
			...commerceTables,
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

	it.each(['expired', 'revoked', 'consumed'] as const)(
		'real issue COMMIT then response loss, recovers original history when %s',
		async (state) => {
			if (!real) throw new Error('Missing real store')
			const f = await realCommerceFixture(pool, real)
			const operationAt = f.getNow()
			f.fault.loseResponse = true
			expect(
				await Effect.runPromise(f.executor.execute(f.request)),
			).toMatchObject({ type: 'Held', mutation: 'Attempted' })
			expect(f.calls).toEqual({ issue: 1, bind: 0, commits: 1 })
			const original = await f.attempt(f.issue.idempotencyKey)
			expect(original.status).toBe('Claimed')
			expect(original.outcome).toBeNull()
			expect(f.issue.issueAt < original.claimedAt.toISOString()).toBe(true)
			const history = await Effect.runPromise(f.reader.inspectIssue(f.issue))
			if (history.type !== 'Recorded')
				throw new Error('Real committed issue missing')
			expect(history.receipt).toEqual(f.committed[0])
			expect(history.operationObservedAt).toEqual({
				type: 'Known',
				at: operationAt,
			})
			if (state === 'expired') f.setNow(f.issue.expiresAt)
			else {
				f.setNow(new Date(original.leaseExpiresAt.getTime() + 1).toISOString())
				if (state === 'revoked')
					await pool.execute('UPDATE AI_Coupon SET status=0 WHERE id=?', [
						history.receipt.coupon.couponId,
					])
				else
					await pool.execute('UPDATE AI_Coupon SET usedCount=1 WHERE id=?', [
						history.receipt.coupon.couponId,
					])
			}
			const before = await f.snapshot()
			expect(before.coupons).toHaveLength(1)
			expect(before.grants).toHaveLength(0)
			expect(before.coupons[0]?.createdAt.toISOString()).toBe(f.issue.issueAt)
			expect(before.coupons[0]?.expires?.toISOString()).toBe(f.issue.expiresAt)
			expect((await f.gate()).authorized).toBe(false)
			const recovered = await recoverWithoutCommerce(f, f.issue)
			expect(recovered.saved.outcome).toEqual({
				type: 'Accepted',
				appliedAt: operationAt,
				providerReceiptId: history.receipt.providerReceiptId,
			})
			expect(recovered.stimulus).toEqual({
				type: 'CouponIssued',
				stimulusId: settlementId(f.issue),
				journeyId: f.issue.journeyId,
				intentKey: f.issue.idempotencyKey,
				coupon: history.receipt.coupon,
			})
			expect((await f.gate()).authorized).toBe(false)
		},
	)

	it.each(['expired', 'revoked', 'consumed', 'deleted-grant'] as const)(
		'real issue and bind each crash after COMMIT; bind recovers %s history',
		async (state) => {
			if (!real) throw new Error('Missing real store')
			const f = await realCommerceFixture(pool, real)
			const issueOperation = f.getNow()
			f.fault.loseResponse = true
			expect(
				(await Effect.runPromise(f.executor.execute(f.request))).type,
			).toBe('Held')
			const issueAttempt = await f.attempt(f.issue.idempotencyKey)
			f.setNow(
				new Date(issueAttempt.leaseExpiresAt.getTime() + 1).toISOString(),
			)
			await recoverWithoutCommerce(f, f.issue)
			const bind = await f.binding()
			const boundAt = f.getNow()
			expect(boundAt > issueOperation).toBe(true)
			f.fault.loseResponse = true
			expect(
				await Effect.runPromise(
					f.executor.execute({
						journeyId: bind.journeyId,
						idempotencyKey: bind.idempotencyKey,
					}),
				),
			).toMatchObject({ type: 'Held', mutation: 'Attempted' })
			const original = await f.attempt(bind.idempotencyKey)
			expect(original.status).toBe('Claimed')
			expect(original.outcome).toBeNull()
			expect(f.calls).toEqual({ issue: 1, bind: 1, commits: 2 })
			const history = await Effect.runPromise(f.reader.inspectBinding(bind))
			if (history.type !== 'Recorded')
				throw new Error('Missing real committed binding')
			expect(history.receipt).toEqual(f.committed[1])
			expect(history.operationObservedAt).toEqual({
				type: 'Known',
				at: issueOperation,
			})
			expect(history.receipt.coupon.binding).toEqual({
				type: 'BoundToVerifiedUser',
				verifiedUserId: f.userId,
				boundAt,
			})
			// Prove the grant was usable before changing exactly one condition.
			expect((await f.gate()).authorized).toBe(true)
			f.setNow(
				state === 'expired'
					? f.issue.expiresAt
					: new Date(original.leaseExpiresAt.getTime() + 1).toISOString(),
			)
			if (state === 'revoked')
				await pool.execute('UPDATE AI_Coupon SET status=0 WHERE id=?', [
					bind.couponId,
				])
			if (state === 'consumed')
				await pool.execute('UPDATE AI_Coupon SET usedCount=1 WHERE id=?', [
					bind.couponId,
				])
			if (state === 'deleted-grant')
				await pool.execute(
					'UPDATE AI_Entitlement SET deletedAt=? WHERE sourceId=?',
					[new Date(f.getNow()), bind.couponId],
				)
			expect((await f.gate()).authorized).toBe(false)
			const rows = await f.snapshot()
			expect(rows.coupons).toHaveLength(1)
			expect(rows.grants).toHaveLength(1)
			expect(rows.grants[0]?.createdAt.toISOString()).toBe(boundAt)
			expect(rows.grants[0]?.expiresAt?.toISOString()).toBe(f.issue.expiresAt)
			const recovered = await recoverWithoutCommerce(f, bind)
			expect(recovered.saved.outcome).toEqual({
				type: 'Accepted',
				appliedAt: boundAt,
				providerReceiptId: history.receipt.providerReceiptId,
			})
			expect(recovered.stimulus).toEqual({
				type: 'CouponBoundToUser',
				stimulusId: settlementId(bind),
				journeyId: bind.journeyId,
				intentKey: bind.idempotencyKey,
				couponId: bind.couponId,
				verifiedUserId: bind.verifiedUserId,
				boundAt,
			})
			expect((await f.gate()).authorized).toBe(false)
			// Concrete reader restores the original ISSUE, not current Bound state.
			expect(
				await Effect.runPromise(f.reader.inspectIssue(f.issue)),
			).toMatchObject({
				type: 'Recorded',
				receipt: f.committed[0],
				operationObservedAt: { type: 'Known', at: issueOperation },
			})
		},
	)

	it.each(['issue', 'bind'] as const)(
		'real %s recorded before domain crash replays the identical full stimulus',
		async (kind) => {
			if (!real) throw new Error('Missing real store')
			const f = await realCommerceFixture(pool, real)
			let intent: CouponIntent = f.issue
			if (kind === 'bind') {
				expect(
					(await Effect.runPromise(f.executor.execute(f.request))).type,
				).toBe('Committed')
				intent = await f.binding()
			}
			f.fault.failDomain = true
			expect(
				(
					await Effect.runPromise(
						f.executor.execute({
							journeyId: intent.journeyId,
							idempotencyKey: intent.idempotencyKey,
						}),
					)
				).type,
			).toBe('Failed')
			const attemptedStimulus = structuredClone(f.stimuli.at(-1))
			expect(attemptedStimulus).toBeDefined()
			const saved = await f.attempt(intent.idempotencyKey)
			expect(saved.status).toBe('Accepted')
			f.setNow(new Date(saved.leaseExpiresAt.getTime() + 1).toISOString())
			f.fault.failDomain = false
			const recovered = await recoverWithoutCommerce(f, intent, true)
			expect(recovered.stimulus).toEqual(attemptedStimulus)
			expect(recovered.saved).toEqual(saved)
			expect(
				(
					await Effect.runPromise(
						f.executor.recoverRecordedPage({
							now: new Date(f.getNow()),
							limit: 10,
						}),
					)
				).scanned,
			).toBe(0)
		},
	)

	it.each(['receipt', 'canonical'] as const)(
		'conflicting %s evidence holds real recovery without writes',
		async (conflict) => {
			if (!real) throw new Error('Missing real store')
			const f = await realCommerceFixture(pool, real)
			f.fault.loseResponse = true
			expect(
				(await Effect.runPromise(f.executor.execute(f.request))).type,
			).toBe('Held')
			const original = await f.attempt(f.issue.idempotencyKey)
			f.setNow(new Date(original.leaseExpiresAt.getTime() + 1).toISOString())
			if (conflict === 'receipt') {
				const rows = await f.snapshot()
				await pool.execute('UPDATE AI_Coupon SET amountDiscount=? WHERE id=?', [
					9999,
					rows.coupons[0]!.id,
				])
				expect(
					await Effect.runPromise(f.reader.inspectIssue(f.issue)),
				).toMatchObject({ type: 'Unknown' })
			} else {
				await pool.execute(
					"UPDATE AI_EvergreenOfferJourneyIntent SET intent=JSON_SET(intent, '$.contactId', ?) WHERE idempotencyKey=?",
					['contradictory-contact', f.issue.idempotencyKey],
				)
			}
			const before = await f.snapshot()
			const calls = { ...f.calls }
			const stimuli = f.stimuli.length
			f.queries.length = 0
			const page = await Effect.runPromise(
				f.executor.recoverUncertainPage({
					now: new Date(f.getNow()),
					limit: 10,
				}),
			)
			expect(page.results).toHaveLength(1)
			expect(page.results[0]).toMatchObject({
				type: 'Held',
				mutation: 'NotAttempted',
			})
			expect(
				f.queries.every(
					(query) => /^select\b/i.test(query) && !/for update/i.test(query),
				),
			).toBe(true)
			expect(f.calls).toEqual(calls)
			expect(f.stimuli).toHaveLength(stimuli)
			expect(await f.snapshot()).toEqual(before)
			// Unknown history does not rewrite the original durable attempt either.
			const after = await f.attempt(f.issue.idempotencyKey)
			expect(after).toEqual(original)
		},
	)
})
