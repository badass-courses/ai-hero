import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import {
	createDrizzleOwnerBirthGuardStore,
	ownerBirthRepostMarker,
	ownerBirthRepostProviderEventId,
} from './owner-birth-guard-drizzle'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

integration('owner-birth guard store on MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let store: ReturnType<typeof createDrizzleOwnerBirthGuardStore>

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_birth_guard_test_${randomUUID().replaceAll('-', '')}`
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
		store = createDrizzleOwnerBirthGuardStore(
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
		providerEventId = id,
	) =>
		pool.query(
			`INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt)
			 VALUES (?, ?, 'pi', 'kit', ?, 'ref', ?, ?, 'internal', '{}', '{}', 1, ?)`,
			[id, contactId, providerEventId, eventType, `key:${id}`, occurredAt],
		)
	const owner = (
		id: string,
		contactId: string,
		occurredAt: string,
		journey = 'value-path-skills-course',
	) =>
		contactEvent(
			id,
			contactId,
			'journey.owner.assigned',
			occurredAt,
			`drovr-owner:${contactId}:${journey}`,
		)
	const window = {
		from: '2026-09-25T00:00:00.000Z',
		to: '2026-09-27T00:00:00.000Z',
	}

	it('pages value-path owner assignments in the window by (occurredAt, id), ties included', async () => {
		await owner('a', 'c1', '2026-09-26 10:00:00')
		await owner('b', 'c2', '2026-09-26 10:00:00')
		await owner('c', 'c3', '2026-09-26 11:00:00')
		// Out of scope: another journey, before and after the window, another type.
		await owner('n', 'c4', '2026-09-26 10:30:00', 'shadow-newsletter')
		await owner(
			'e',
			'c5',
			'2026-09-26 10:30:00',
			'crash-course-evergreen-offer',
		)
		await owner('old', 'c6', '2026-09-24 23:59:59')
		await owner('new', 'c7', '2026-09-27 00:00:01')
		await contactEvent('u', 'c1', 'contact.unsubscribed', '2026-09-26 10:30:00')

		const first = await store.scanOwners({ ...window, limit: 1 })
		expect(first.map((row) => row.id)).toEqual(['a'])
		expect(first[0]).toMatchObject({
			contactId: 'c1',
			eventType: 'journey.owner.assigned',
			providerEventId: 'drovr-owner:c1:value-path-skills-course',
			semanticIdempotencyKey: 'key:a',
			occurredAt: '2026-09-26T10:00:00.000Z',
		})
		const rest = await store.scanOwners({
			...window,
			after: { occurredAt: first[0]!.occurredAt, id: first[0]!.id },
			limit: 5,
		})
		expect(rest.map((row) => row.id)).toEqual(['b', 'c'])
	})

	it('finds the contacts with any stop', async () => {
		await contactEvent('u', 'c1', 'contact.unsubscribed', '2026-09-26 10:00:00')
		await contactEvent('b', 'c2', 'contact.bounced', '2026-09-26 10:00:00')
		await contactEvent('k', 'c3', 'contact.complained', '2026-09-26 10:00:00')
		await contactEvent(
			's',
			'c4',
			'skills-newsletter.subscribed',
			'2026-09-26 10:00:00',
		)
		expect(
			await store.stoppedContactIds(['c1', 'c2', 'c3', 'c4', 'c5']),
		).toEqual(new Set(['c1', 'c2', 'c3']))
		expect(await store.stoppedContactIds([])).toEqual(new Set())
	})

	it('finds the owners the guard already re-posted, by its marker', async () => {
		await owner('a', 'c1', '2026-09-26 10:00:00')
		await owner('b', 'c2', '2026-09-26 10:00:00')
		const [ownerA] = await store.scanOwners({ ...window, limit: 1 })
		const marker = ownerBirthRepostMarker(
			ownerA!,
			'accepted',
			'2026-09-27T01:40:00.000Z',
		)
		await contactEvent(
			'm',
			marker.contactId,
			marker.eventType,
			'2026-09-27 01:40:00',
			marker.providerEventId,
		)
		expect(marker.providerEventId).toBe(ownerBirthRepostProviderEventId('a'))
		expect(
			await store.repostedOwnerEventIds([
				{ id: 'a', contactId: 'c1' },
				{ id: 'b', contactId: 'c2' },
			]),
		).toEqual(new Set(['a']))
	})

	it('rides the (eventType, occurredAt, id) index', async () => {
		const [plan] = await pool.query(
			"EXPLAIN SELECT id FROM AI_ContactEvent WHERE eventType = 'journey.owner.assigned' AND occurredAt >= '2026-09-25 00:00:00' AND occurredAt <= '2026-09-27 00:00:00' AND providerEventId LIKE '%:value-path-skills-course' ORDER BY occurredAt, id LIMIT 50",
		)
		expect((plan as { key: string | null }[])[0]?.key).toBe(
			'ContactEvent_eventType_occurredAt_id_idx',
		)
	})
})
