import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import {
	drovrOutboxDedupeKey,
	DrovrOutboxUnavailableError,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import { createDrizzleDrovrOutboxStore } from './drovr-outbox-drizzle'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

const PROD = 'https://drovr.example#production'
const PREVIEW = 'https://drovr-stage.example#preview:worker/x'

integration('drovr outbox store on MySQL (row 204)', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let store: ReturnType<typeof createDrizzleDrovrOutboxStore>

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_drovr_outbox_test_${randomUUID().replaceAll('-', '')}`
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
		store = createDrizzleDrovrOutboxStore(
			drizzle(pool, { schema: databaseSchema, mode: 'default' }),
		)
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	const applyMigration = async () =>
		pool.query(
			await fs.readFile(
				new URL(
					'../../db/migrations/20260930_ai_hero_drovr_outbox.sql',
					import.meta.url,
				),
				'utf8',
			),
		)

	let serial = 0
	const row = (overrides: Partial<DrovrOutboxRow> = {}): DrovrOutboxRow => {
		serial += 1
		const entry = outboxEntryForEvent(
			{
				tenantId: 'org-aihero',
				contactId: `contact-${serial}`,
				journeyId: 'value-path-skills-course',
				type: 'contact.created',
				occurredAt: '2026-09-30T10:00:00.000Z',
				idempotencyKey: `owner:birth:${serial}`,
			},
			'live',
		)
		const target = overrides.target ?? PROD
		return {
			...entry,
			id: `row-${serial}`,
			dedupeKey: drovrOutboxDedupeKey(target, entry),
			target,
			status: 'pending',
			attempts: 0,
			lastStatus: 503,
			lastError: 'drovr answered 503',
			firstFailedAt: '2026-09-30T11:00:00.000Z',
			nextAttemptAt: '2026-09-30T11:00:00.000Z',
			lastAttemptAt: null,
			deliveredAt: null,
			releasedAt: null,
			createdAt: '2026-09-30T11:00:00.000Z',
			...overrides,
		}
	}

	it('answers unavailable on every call before the migration is applied', async () => {
		await expect(store.insertIgnore([row()])).rejects.toBeInstanceOf(
			DrovrOutboxUnavailableError,
		)
		await expect(
			store.due({ target: PROD, now: '2026-09-30T12:00:00.000Z', limit: 10 }),
		).rejects.toBeInstanceOf(DrovrOutboxUnavailableError)
		await expect(store.depth(PROD)).rejects.toBeInstanceOf(
			DrovrOutboxUnavailableError,
		)
	})

	describe('with the table', () => {
		beforeAll(async () => {
			await applyMigration()
			// Rerunnable: a second apply is a no-op.
			await applyMigration()
		})
		beforeEach(async () => {
			await pool.query('DELETE FROM AI_DrovrOutbox')
		})

		it('keeps the exact body and ignores a second capture of the same send', async () => {
			const first = row()
			await store.insertIgnore([first])
			await store.insertIgnore([{ ...first, id: 'row-again' }])
			const due = await store.due({
				target: PROD,
				now: '2026-09-30T12:00:00.000Z',
				limit: 10,
			})
			expect(due).toHaveLength(1)
			expect(due[0]).toEqual(first)
		})

		it("takes only this target's pending rows that are due", async () => {
			const mine = row()
			await store.insertIgnore([
				mine,
				row({ target: PREVIEW }),
				row({ nextAttemptAt: '2026-09-30T13:00:00.000Z' }),
				row({ status: 'held' }),
				row({ status: 'delivered', deliveredAt: '2026-09-30T11:30:00.000Z' }),
			])
			const due = await store.due({
				target: PROD,
				now: '2026-09-30T12:00:00.000Z',
				limit: 10,
			})
			expect(due.map((r) => r.id)).toEqual([mine.id])
		})

		it('updates a row and reads the depth per target', async () => {
			const pending = row({ firstFailedAt: '2026-09-30T09:00:00.000Z' })
			const held = row({ status: 'held' })
			await store.insertIgnore([
				pending,
				held,
				row({ status: 'rejected' }),
				row({ target: PREVIEW }),
			])
			await store.update(pending.id, {
				attempts: 1,
				nextAttemptAt: '2026-09-30T12:05:00.000Z',
				lastAttemptAt: '2026-09-30T12:00:00.000Z',
			})
			expect(await store.depth(PROD)).toEqual({
				pending: 1,
				oldestPendingFailedAt: '2026-09-30T09:00:00.000Z',
				held: 1,
				rejected: 1,
			})
			const [updated] = await store.due({
				target: PROD,
				now: '2026-09-30T12:10:00.000Z',
				limit: 10,
			})
			expect(updated).toMatchObject({
				attempts: 1,
				lastAttemptAt: '2026-09-30T12:00:00.000Z',
			})
		})

		it('deletes delivered rows older than the cutoff, and never held or rejected rows', async () => {
			const expired = row({
				status: 'delivered',
				deliveredAt: '2026-09-20T00:00:00.000Z',
			})
			const recent = row({
				status: 'delivered',
				deliveredAt: '2026-09-29T00:00:00.000Z',
			})
			// Only status decides: even a held or rejected row carrying an old
			// deliveredAt (an operator's hand edit) is kept until resolved.
			const held = row({
				status: 'held',
				createdAt: '2026-09-01T00:00:00.000Z',
				deliveredAt: '2026-09-01T00:00:00.000Z',
			})
			const rejected = row({
				status: 'rejected',
				createdAt: '2026-09-01T00:00:00.000Z',
				deliveredAt: '2026-09-01T00:00:00.000Z',
			})
			await store.insertIgnore([expired, recent, held, rejected])
			expect(
				await store.deleteDeliveredBefore('2026-09-23T00:00:00.000Z', 500),
			).toBe(1)
			const [ids] = (await pool.query(
				'SELECT id FROM AI_DrovrOutbox ORDER BY id',
			)) as unknown as [{ id: string }[]]
			expect(ids.map((r) => r.id).sort()).toEqual(
				[recent.id, held.id, rejected.id].sort(),
			)
		})
	})
})
