import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { createDrizzleContactSyncStore } from './contact-sync-reconcile-drizzle'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

integration('contact sync reconcile reads on MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let store: ReturnType<typeof createDrizzleContactSyncStore>

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_contact_sync_test_${randomUUID().replaceAll('-', '')}`
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
		for (const migration of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260926_ai_hero_contact_sync.sql',
			'20260926_ai_hero_link_anchor_issued_at_index.sql',
			'20260926_ai_hero_contact_profile_hash.sql',
		])
			await pool.query(
				await fs.readFile(
					new URL(`../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		store = createDrizzleContactSyncStore(
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
		await pool.query('DELETE FROM AI_ValuePathLinkAnchor')
		await pool.query('DELETE FROM AI_ContactSyncCursor')
	})

	const contactEvent = (
		id: string,
		contactId: string,
		occurredAt: string,
		eventType = 'skills-newsletter.subscribed',
		createdAt = occurredAt,
	) =>
		pool.query(
			`INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt, createdAt)
			 VALUES (?, ?, 'pi', 'kit', ?, 'ref', ?, ?, 'internal', '{}', '{}', 1, ?, ?)`,
			[id, contactId, id, eventType, `key:${id}`, occurredAt, createdAt],
		)

	it('scans every event type after the start and through the end, in (occurredAt, id) order, one past the limit', async () => {
		await contactEvent('e0', 'c0', '2026-09-26 16:40:00') // == after: excluded
		await contactEvent('e2', 'c2', '2026-09-26 17:10:00')
		await contactEvent(
			'e1',
			'c1',
			'2026-09-26 17:10:00',
			'contact.unsubscribed',
		)
		await contactEvent('e3', 'c3', '2026-09-26 17:58:00') // == through: included
		await contactEvent('e4', 'c4', '2026-09-26 17:58:01') // after through
		await expect(
			store.scanChanges({
				scope: 'fresh',
				after: '2026-09-26T16:40:00.000Z',
				through: '2026-09-26T17:58:00.000Z',
				limit: 5000,
			}),
		).resolves.toEqual([
			{
				id: 'e1',
				contactId: 'c1',
				eventType: 'contact.unsubscribed',
				occurredAt: '2026-09-26T17:10:00.000Z',
			},
			{
				id: 'e2',
				contactId: 'c2',
				eventType: 'skills-newsletter.subscribed',
				occurredAt: '2026-09-26T17:10:00.000Z',
			},
			{
				id: 'e3',
				contactId: 'c3',
				eventType: 'skills-newsletter.subscribed',
				occurredAt: '2026-09-26T17:58:00.000Z',
			},
		])
		const limited = await store.scanChanges({
			scope: 'fresh',
			after: '2026-09-26T16:40:00.000Z',
			through: '2026-09-26T17:58:00.000Z',
			limit: 1,
		})
		expect(limited.map((row) => row.id)).toEqual(['e1', 'e2'])
	})

	it('finds only late writes behind the watermark: written after it, under an old occurredAt', async () => {
		// Claimed by the previous run: written before the watermark.
		await contactEvent('seen', 'c1', '2026-09-26 17:10:00', 'kit.message', '2026-09-26 17:10:00')
		// Written after the watermark with an old occurredAt: a late write.
		await contactEvent('late', 'c2', '2026-09-26 17:20:00', 'kit.message', '2026-09-26 17:45:00')
		const rows = await store.scanChanges({
			scope: 'overlap',
			after: '2026-09-26T16:40:00.000Z',
			through: '2026-09-26T17:40:00.000Z',
			writtenAfter: '2026-09-26T17:40:00.000Z',
			limit: 5000,
		})
		expect(rows.map((row) => row.id)).toEqual(['late'])
	})

	it('rides the occurredAt and issuedAt indexes', async () => {
		const [scanPlan] = await pool.query(
			"EXPLAIN SELECT id FROM AI_ContactEvent WHERE occurredAt > '2026-09-26 16:40:00' AND occurredAt <= '2026-09-26 17:58:00' ORDER BY occurredAt, id LIMIT 5001",
		)
		expect((scanPlan as { key: string | null }[])[0]?.key).toBe(
			'ContactEvent_occurredAt_idx',
		)
		const [rotationPlan] = await pool.query(
			"EXPLAIN SELECT contactId FROM AI_ValuePathLinkAnchor WHERE issuedAt > '2026-06-28 17:40:00.000' AND issuedAt <= '2026-06-28 17:58:00.000' GROUP BY contactId",
		)
		expect((rotationPlan as { key: string | null }[])[0]?.key).toBe(
			'ValuePathLinkAnchor_issuedAt_idx',
		)
	})

	it('finds the contacts whose links reached a 90-day step inside the window', async () => {
		const anchor = (contactId: string, issuedAt: string, email = 'email-2') =>
			pool.query(
				`INSERT INTO AI_ValuePathLinkAnchor (anchorKey, contactId, valuePathSlug, emailResourceId, fingerprint, issuedAt, expiresAt)
				 VALUES (?, ?, 'ai-hero-skills-workflow', ?, 'f', ?, ?)`,
				[
					`${contactId}:${email}:${issuedAt}`,
					contactId,
					`ai-hero-skills-workflow.${email}`,
					issuedAt,
					issuedAt,
				],
			)
		await anchor('rot-90', '2026-06-28 17:50:00.000') // 90 d before the window
		await anchor('rot-90', '2026-06-28 17:51:00.000', 'email-3') // same contact
		await anchor('rot-180', '2026-03-30 17:45:00.000') // 180 d
		await anchor('edge-out', '2026-06-28 17:40:00.000') // == after - 90 d: out
		await anchor('fresh', '2026-09-26 17:50:00.000') // first window
		const window = {
			after: '2026-09-26T17:40:00.000Z',
			through: '2026-09-26T17:58:00.000Z',
		}
		// Each with the instant its step fell, earliest per contact, in order.
		await expect(
			store.rotatedContacts({ ...window, limit: 10 }),
		).resolves.toEqual([
			{ contactId: 'rot-180', at: '2026-09-26T17:45:00.000Z' },
			{ contactId: 'rot-90', at: '2026-09-26T17:50:00.000Z' },
		])
		// At most limit + 1, so the reconcile can see it overflowed.
		await expect(
			store.rotatedContacts({ ...window, limit: 0 }),
		).resolves.toEqual([
			{ contactId: 'rot-180', at: '2026-09-26T17:45:00.000Z' },
		])
	})

	it('reads no watermark at first, then only ever moves it forward', async () => {
		await expect(store.readWatermark()).resolves.toBeUndefined()
		await store.writeWatermark(
			'2026-09-26T17:58:00.000Z',
			'2026-09-26T18:00:01.000Z',
		)
		await expect(store.readWatermark()).resolves.toBe(
			'2026-09-26T17:58:00.000Z',
		)
		// A slower, older run must not move it back.
		await store.writeWatermark(
			'2026-09-26T17:43:00.000Z',
			'2026-09-26T18:00:02.000Z',
		)
		await expect(store.readWatermark()).resolves.toBe(
			'2026-09-26T17:58:00.000Z',
		)
		await store.writeWatermark(
			'2026-09-26T18:13:00.000Z',
			'2026-09-26T18:15:01.000Z',
		)
		await expect(store.readWatermark()).resolves.toBe(
			'2026-09-26T18:13:00.000Z',
		)
	})
})
