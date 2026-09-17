import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { contactEvent } from '@/db/schema'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { Effect, Either } from 'effect'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import { createDrizzleJourneyAttempts } from './drizzle-attempts'
import { createBoundedJourneyReaders } from './bounded-readers'
import {
	fixtureEntry,
	fixtureWake,
	sourceFixture,
	currentCourseSourceFixture,
} from './bounded-readers.fixtures'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
function connection(uri: string) {
	const pool = preserveQueryResultShape(
		mysql.createPool({ uri, timezone: 'Z', connectionLimit: 1 }),
	)
	const database = drizzle(pool, {
		schema: { ...journeySchema, contactEvent },
		mode: 'planetscale',
	})
	const ledger = createDrizzleJourneyLedger(database)
	return {
		pool,
		database,
		ledger,
		readers: createBoundedJourneyReaders(database, ledger),
		attempts: createDrizzleJourneyAttempts(database),
	}
}
integration('bounded reader MySQL contract', () => {
	let server: Pool
	let admin: Pool
	let connected: ReturnType<typeof connection>
	let databaseName: string
	beforeAll(async () => {
		const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({
			uri: safe.toString(),
			connectionLimit: 1,
			timezone: 'Z',
		})
		databaseName = `aih_reader_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
		)
		const uri = new URL(safe)
		uri.pathname = `/${databaseName}`
		admin = mysql.createPool({
			uri: uri.toString(),
			connectionLimit: 1,
			timezone: 'Z',
			multipleStatements: true,
		})
		for (const name of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260714_ai_hero_optin_attribution.sql',
			'20260717_ai_hero_side_effect_intent_completed_at.sql',
			'plans/20260908_contact_email_equivalence.sql',
			'20260831_ai_hero_email_course_evergreen_schema.sql',
			'20260907_evergreen_admission_attempts.sql',
		]) {
			await admin.query(
				await fs.readFile(
					new URL(`../../../db/migrations/${name}`, import.meta.url),
					'utf8',
				),
			)
		}
		connected = connection(uri.toString())
	})
	beforeEach(async () => {
		for (const table of [
			'AI_EvergreenOfferJourneyAttempt',
			'AI_EvergreenOfferJourneyWake',
			'AI_EvergreenOfferJourneyIntent',
			'AI_EvergreenOfferJourneyCommit',
			'AI_ContactEvent',
		])
			await admin.query(`DELETE FROM \`${table}\``)
	})
	afterAll(async () => {
		await connected?.pool.end()
		await admin?.end()
		if (databaseName) await server.query(`DROP DATABASE \`${databaseName}\``)
		await server?.end()
	})
	it('keysets source ties and resumes after a held-only page without granting admission', async () => {
		const a = { ...sourceFixture('a'), schemaVersion: 2 }
		const b = sourceFixture('b')
		const c = sourceFixture('c', 'ai-hero-skills-team-workflow')
		await connected.database.insert(contactEvent).values([a, b, c])
		const input = { now: a.occurredAt, limit: 1 }
		const first = await Effect.runPromise(connected.readers.source(input))
		expect(first).toMatchObject({
			scanned: 1,
			end: false,
			candidates: [],
			held: [{ reason: 'InvalidSource' }],
		})
		if (!first.nextCursor) throw new Error('Missing continuation')
		// Reconstructing a reader demonstrates that continuation is explicit data.
		const resumed = createBoundedJourneyReaders(
			connected.database,
			connected.ledger,
		)
		const second = await Effect.runPromise(
			resumed.source({ ...input, after: first.nextCursor }),
		)
		expect(second.candidates[0]?.entryFactId).toBe('b')
		if (!second.nextCursor) throw new Error('Missing continuation')
		const third = await Effect.runPromise(
			resumed.source({ ...input, after: second.nextCursor }),
		)
		expect(third.candidates[0]?.entryFactId).toBe('c')
		if (!third.nextCursor) throw new Error('Missing continuation')
		expect(
			await Effect.runPromise(
				resumed.source({ ...input, after: third.nextCursor }),
			),
		).toMatchObject({ scanned: 0, end: true })
		expect(await Effect.runPromise(resumed.source(input))).toEqual(first)
		const [count] = await admin.query<Array<RowDataPacket & { total: number }>>(
			'SELECT COUNT(*) AS total FROM AI_EvergreenOfferJourneyCommit',
		)
		expect(Number(count[0]?.total)).toBe(0)
	})
	it('round-trips the current writer DeliverySettled payload through source SQL and canonical restoration', async () => {
		const row = currentCourseSourceFixture()
		await connected.database.insert(contactEvent).values(row)
		const page = await Effect.runPromise(
			connected.readers.source({
				now: new Date(row.payloadSummary.coursePayload.payload.exhaustedAt),
				limit: 10,
			}),
		)
		expect(page.scanned).toBe(1)
		expect(page.held).toEqual([])
		expect(page.candidates).toHaveLength(1)
		expect(page.candidates[0]).toMatchObject({
			entryFactId: row.id,
			contactId: row.contactId,
			exhaustedAt: '2026-09-04T17:00:00.789Z',
		})
		expect(page.nextCursor).toEqual({
			id: row.id,
			at: '2026-09-04T17:00:00.000Z',
		})
	})
	it('uses the source event-time index without scanning unrelated event history', async () => {
		const row = sourceFixture()
		await connected.database.insert(contactEvent).values(row)
		await connected.database.insert(contactEvent).values(
			Array.from({ length: 200 }, (_, i) => ({
				...sourceFixture(`noise-${i}`),
				eventType: 'unrelated.event',
			})),
		)
		const [plan] = await admin.query<
			Array<RowDataPacket & { key: string; possible_keys: string }>
		>(
			'EXPLAIN SELECT id FROM AI_ContactEvent WHERE eventType = ? AND occurredAt <= ? ORDER BY occurredAt,id LIMIT 1',
			['course.sequence-exhausted', row.occurredAt],
		)
		expect(plan[0]?.possible_keys).toContain(
			'ContactEvent_eventType_occurredAt_id_idx',
		)
		expect(plan[0]?.key).toBe('ContactEvent_eventType_occurredAt_id_idx')
		const page = await Effect.runPromise(
			connected.readers.source({ now: row.occurredAt, limit: 10 }),
		)
		expect(page.scanned).toBe(1)
		expect(page.candidates).toHaveLength(1)
	})
	it('reads exact due boundaries and stable wake/intent ties with full canonical restoration', async () => {
		const a = fixtureEntry('a')
		const b = fixtureEntry('b')
		await Effect.runPromise(connected.ledger.commit(a))
		await Effect.runPromise(connected.ledger.commit(b))
		const wa = fixtureWake(a.decision.next)
		const wb = fixtureWake(b.decision.next)
		const now = new Date(wa.decidedAt)
		expect(
			(
				await Effect.runPromise(
					connected.readers.wakes({
						now: new Date(now.getTime() - 1),
						limit: 100,
					}),
				)
			).scanned,
		).toBe(0)
		const first = await Effect.runPromise(
			connected.readers.wakes({ now, limit: 1 }),
		)
		if (!first.nextCursor) throw new Error('Missing cursor')
		const second = await Effect.runPromise(
			connected.readers.wakes({ now, limit: 1, after: first.nextCursor }),
		)
		expect(first.candidates).toHaveLength(1)
		expect(second.candidates).toHaveLength(1)
		expect(first.candidates[0]?.wakeId).not.toBe(second.candidates[0]?.wakeId)
		await Effect.runPromise(connected.ledger.commit(wa))
		await Effect.runPromise(connected.ledger.commit(wb))
		const intents = await Effect.runPromise(
			connected.readers.intents({ now, limit: 1 }),
		)
		if (!intents.nextCursor) throw new Error('Missing cursor')
		const next = await Effect.runPromise(
			connected.readers.intents({ now, limit: 1, after: intents.nextCursor }),
		)
		expect(intents.candidates[0]?.window).toBe('Open')
		expect(next.candidates[0]?.intent.idempotencyKey).not.toBe(
			intents.candidates[0]?.intent.idempotencyKey,
		)
		const intent = intents.candidates[0]?.intent
		if (!intent || intent.type !== 'SendMessage')
			throw new Error('Missing message')
		await Effect.runPromise(
			connected.attempts.claim({
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				now,
				leaseExpiresAt: new Date(now.getTime() + 60_000),
			}),
		)
		const expired = await Effect.runPromise(
			connected.readers.intents({ now: new Date(intent.notAfter), limit: 100 }),
		)
		expect(expired.candidates.length).toBeGreaterThan(0)
		expect(
			expired.candidates.every((candidate) => candidate.window === 'Expired'),
		).toBe(true)
		expect(
			(
				await Effect.runPromise(
					connected.attempts.claim({
						idempotencyKey: intent.idempotencyKey,
						journeyId: intent.journeyId,
						now: new Date(intent.notAfter),
						leaseExpiresAt: new Date(Date.parse(intent.notAfter) + 60_000),
					}),
				)
			).type,
		).toBe('AlreadyAttempted')
	})
	it('holds corrupt wake evidence without advancing the journey', async () => {
		const entry = fixtureEntry()
		await Effect.runPromise(connected.ledger.commit(entry))
		const due = fixtureWake(entry.decision.next)
		await admin.query(
			"UPDATE AI_EvergreenOfferJourneyWake SET wake = JSON_OBJECT('corrupt', true)",
		)
		const page = await Effect.runPromise(
			connected.readers.wakes({ now: new Date(due.decidedAt), limit: 1 }),
		)
		expect(page).toMatchObject({
			scanned: 1,
			candidates: [],
			held: [{ reason: 'InvalidCanonicalEvidence' }],
		})
		expect(page.nextCursor).not.toBeNull()
	})

	it('holds corrupt canonical rows with fixed reasons and advances past them', async () => {
		const entry = fixtureEntry()
		await Effect.runPromise(connected.ledger.commit(entry))
		const wake = fixtureWake(entry.decision.next)
		await Effect.runPromise(connected.ledger.commit(wake))
		await admin.query(
			"UPDATE AI_EvergreenOfferJourneyIntent SET intent = JSON_OBJECT('bad', 'private-invalid-payload')",
		)
		const result = await Effect.runPromise(
			connected.readers.intents({ now: new Date(wake.decidedAt), limit: 1 }),
		)
		expect(result).toMatchObject({
			scanned: 1,
			candidates: [],
			held: [{ reason: 'InvalidCanonicalEvidence' }],
			end: false,
		})
		expect(JSON.stringify(result)).not.toContain('private-invalid-payload')
		const invalid = await Effect.runPromise(
			Effect.either(
				connected.readers.intents({
					now: new Date(wake.decidedAt),
					limit: 101,
				}),
			),
		)
		expect(Either.isLeft(invalid) && invalid.left.reason).toBe('InvalidPage')
	})
})
