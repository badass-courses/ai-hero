import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import { getTableConfig } from 'drizzle-orm/mysql-core'
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

const PROD = 'production'
const PREVIEW = 'preview:worker/x'

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

		it('has exactly the indexes the Drizzle schema declares (no drift from the deploy request)', async () => {
			const [rows] = (await pool.query(
				`SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col
				 FROM information_schema.STATISTICS
				 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AI_DrovrOutbox'
				 ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
			)) as unknown as [
				{ name: string; nonUnique: number | string; col: string }[],
			]
			const live = new Map<string, { unique: boolean; columns: string[] }>()
			for (const r of rows) {
				if (r.name === 'PRIMARY') continue
				const entry = live.get(r.name) ?? {
					unique: Number(r.nonUnique) === 0,
					columns: [],
				}
				entry.columns.push(r.col)
				live.set(r.name, entry)
			}
			const declared = new Map(
				getTableConfig(drovrOutbox).indexes.map((i) => [
					i.config.name,
					{
						unique: Boolean(i.config.unique),
						columns: i.config.columns.map((c) => (c as { name: string }).name),
					},
				]),
			)
			expect(Object.fromEntries(live)).toEqual(Object.fromEntries(declared))
			expect(live.get('DrovrOutbox_contact_idx')).toEqual({
				unique: false,
				columns: ['target', 'contactId', 'status'],
			})
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

		it('absorbs only a duplicate: a value that does not fit fails instead of being truncated', async () => {
			const first = row()
			await store.insertIgnore([first])
			await store.insertIgnore([
				{ ...first, id: 'row-dup', lastError: 'second' },
			])
			const [kept] = (await pool.query(
				'SELECT id, lastError FROM AI_DrovrOutbox',
			)) as unknown as [{ id: string; lastError: string }[]]
			expect(kept).toEqual([{ id: first.id, lastError: first.lastError }])
			await expect(
				store.insertIgnore([row({ idempotencyKey: 'k'.repeat(501) })]),
			).rejects.toThrow()
		})

		it("reads this target's pending and held births for the given contacts", async () => {
			const birth = (overrides: Partial<DrovrOutboxRow>) =>
				row({ eventType: 'contact.created', ...overrides })
			const open = birth({
				contactId: 'c1',
				journeyId: 'value-path-skills-course',
			})
			const held = birth({
				contactId: 'c2',
				status: 'held',
				journeyId: 'crash-course-evergreen-offer',
			})
			const signup = row({
				contactId: 'c3',
				endpoint: 'signups',
				eventType: 'signup',
				journeyId: 'signup:form-1',
			})
			await store.insertIgnore([
				open,
				held,
				signup,
				birth({
					contactId: 'c1',
					status: 'delivered',
					deliveredAt: '2026-09-30T11:30:00.000Z',
				}),
				birth({ contactId: 'c1', target: PREVIEW }),
				birth({ contactId: 'c9' }),
				// A fact is not a birth.
				row({ contactId: 'c1', eventType: 'value-path.answer-selected' }),
			])
			const births = await store.openGates({
				target: PROD,
				contactIds: ['c1', 'c2', 'c3'],
			})
			expect(
				births
					.map((b) => `${b.contactId}|${b.journeyId}|${b.endpoint}|${b.status}`)
					.sort(),
			).toEqual([
				'c1|value-path-skills-course|events|pending',
				'c2|crash-course-evergreen-offer|events|held',
				'c3|signup:form-1|signups|pending',
			])
			expect(births.find((b) => b.contactId === 'c1')?.nextAttemptAt).toBe(
				open.nextAttemptAt,
			)
			expect(await store.openGates({ target: PROD, contactIds: [] })).toEqual(
				[],
			)
		})

		it("reads this target's open stops too, a refused one included, over the contact index (row 204b)", async () => {
			const stop = (overrides: Partial<DrovrOutboxRow>) =>
				row({ eventType: 'purchase.recorded', ...overrides })
			await store.insertIgnore([
				stop({ contactId: 'c1', firstFailedAt: '2026-09-30T10:30:00.000Z' }),
				stop({
					contactId: 'c1',
					eventType: 'contact.unsubscribed',
					status: 'rejected',
					firstFailedAt: '2026-09-30T10:00:00.000Z',
				}),
				stop({ contactId: 'c2', eventType: 'contact.bounced', status: 'held' }),
				stop({
					contactId: 'c1',
					eventType: 'contact.complained',
					status: 'delivered',
					deliveredAt: '2026-09-30T11:30:00.000Z',
					firstFailedAt: '2026-09-30T08:00:00.000Z',
				}),
				stop({ contactId: 'c1', target: PREVIEW }),
				// A refused birth is not a gate; a refused stop is.
				row({ contactId: 'c1', status: 'rejected' }),
				// A fact is neither.
				row({ contactId: 'c1', eventType: 'value-path.answer-selected' }),
			])
			const gates = await store.openGates({
				target: PROD,
				contactIds: ['c1', 'c2'],
			})
			expect(
				gates.map((g) => `${g.contactId}|${g.eventType}|${g.status}`).sort(),
			).toEqual([
				'c1|contact.unsubscribed|rejected',
				'c1|purchase.recorded|pending',
				'c2|contact.bounced|held',
			])
			expect(gates[0]?.occurredAt).toBe('2026-09-30T10:00:00.000Z')
			expect((await store.depth(PROD)).oldestOpenStopFailedAt).toBe(
				'2026-09-30T10:00:00.000Z',
			)
			const [plan] = (await pool.query(
				`EXPLAIN SELECT id FROM AI_DrovrOutbox WHERE target = ? AND contactId IN (?, ?) AND status IN ('pending', 'held', 'rejected')`,
				[PROD, 'c1', 'c2'],
			)) as unknown as [{ possible_keys: string | null }[]]
			expect(plan[0]?.possible_keys ?? '').toContain('DrovrOutbox_contact_idx')
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
				oldestOpenStopFailedAt: null,
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
