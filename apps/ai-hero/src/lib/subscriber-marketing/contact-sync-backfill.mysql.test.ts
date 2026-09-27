import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { createDrizzleBackfillScan } from './contact-sync-backfill-drizzle'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

integration('contact sync backfill scan on MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let scan: ReturnType<typeof createDrizzleBackfillScan>

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_backfill_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = mysql.createPool({
			uri: target.toString(),
			timezone: 'Z',
			multipleStatements: true,
		})
		const acquire = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(await acquire())) as typeof pool.getConnection
		// The chain the email-course suite applies; 20260831 adds the
		// (eventType, occurredAt, id) index this scan rides.
		for (const migration of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260714_ai_hero_optin_attribution.sql',
			'20260717_ai_hero_side_effect_intent_completed_at.sql',
			'plans/20260908_contact_email_equivalence.sql',
			'20260831_ai_hero_email_course_evergreen_schema.sql',
		])
			await pool.query(
				await fs.readFile(
					new URL(`../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		scan = createDrizzleBackfillScan(
			drizzle(pool, { schema: databaseSchema, mode: 'default' }),
		)
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		await pool.query('DELETE FROM AI_ContactEvent')
	})

	const contactEvent = (
		id: string,
		contactId: string,
		eventType: string,
		occurredAt: string,
	) =>
		pool.query(
			`INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt)
			 VALUES (?, ?, 'pi', 'kit', ?, 'ref', ?, ?, 'internal', '{}', '{}', 1, ?)`,
			[id, contactId, id, eventType, `key:${id}`, occurredAt],
		)

	it('pages one event type by (occurredAt, id), resuming after the last row, ties included', async () => {
		await contactEvent(
			'a',
			'c1',
			'journey.owner.assigned',
			'2026-09-20 10:00:00',
		)
		await contactEvent(
			'b',
			'c2',
			'journey.owner.assigned',
			'2026-09-20 10:00:00',
		)
		await contactEvent(
			'c',
			'c3',
			'journey.owner.assigned',
			'2026-09-21 10:00:00',
		)
		await contactEvent('x', 'c9', 'contact.unsubscribed', '2026-09-20 10:00:00')
		const first = await scan({ eventType: 'journey.owner.assigned', limit: 1 })
		expect(first.map((row) => row.id)).toEqual(['a'])
		// Same occurredAt as the cursor, later id: still found.
		const second = await scan({
			eventType: 'journey.owner.assigned',
			afterOccurredAt: first[0]!.occurredAt,
			afterId: first[0]!.id,
			limit: 5,
		})
		expect(second.map((row) => row.id)).toEqual(['b', 'c'])
		expect(second[0]).toEqual({
			id: 'b',
			contactId: 'c2',
			eventType: 'journey.owner.assigned',
			providerEventId: 'b',
			occurredAt: '2026-09-20T10:00:00.000Z',
		})
	})

	it('rides the (eventType, occurredAt, id) index', async () => {
		const [plan] = await pool.query(
			"EXPLAIN SELECT id FROM AI_ContactEvent WHERE eventType = 'journey.owner.assigned' AND (occurredAt > '2026-09-20 10:00:00' OR (occurredAt = '2026-09-20 10:00:00' AND id > 'a')) ORDER BY occurredAt, id LIMIT 50",
		)
		expect((plan as { key: string | null }[])[0]?.key).toBe(
			'ContactEvent_eventType_occurredAt_id_idx',
		)
	})
})
