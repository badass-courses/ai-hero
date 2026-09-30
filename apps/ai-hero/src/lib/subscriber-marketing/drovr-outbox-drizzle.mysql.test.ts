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

		it("reads a pending evergreen start as a birth, and no other journey's exhaustion (row 201g)", async () => {
			const start = row({
				contactId: 'e1',
				eventType: 'course.sequence-exhausted',
				journeyId: 'crash-course-evergreen-offer',
			})
			await store.insertIgnore([
				start,
				// The skills course's exhaustion is a fact there.
				row({
					contactId: 'e2',
					eventType: 'course.sequence-exhausted',
					journeyId: 'value-path-skills-course',
				}),
			])
			const gates = await store.openGates({
				target: PROD,
				contactIds: ['e1', 'e2'],
			})
			expect(
				gates.map((g) => `${g.contactId}|${g.journeyId}|${g.eventType}`),
			).toEqual(['e1|crash-course-evergreen-offer|course.sequence-exhausted'])
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
				// Held by a human: still a gate, but not the alert's oldest stop.
				stop({
					contactId: 'c2',
					eventType: 'contact.bounced',
					status: 'held',
					firstFailedAt: '2026-09-30T09:00:00.000Z',
				}),
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
			// Each gate carries its row id: the replay tells two stops apart by it.
			const [ids] = (await pool.query(
				`SELECT id FROM AI_DrovrOutbox WHERE target = ? AND contactId IN ('c1', 'c2') AND eventType IN ('purchase.recorded', 'contact.unsubscribed', 'contact.bounced') AND status <> 'delivered'`,
				[PROD],
			)) as unknown as [{ id: string }[]]
			expect(gates.map((g) => g.id).sort()).toEqual(ids.map((r) => r.id).sort())
			expect((await store.depth(PROD)).oldestOpenStopFailedAt).toBe(
				'2026-09-30T10:00:00.000Z',
			)
			// The statement the store really sends, EXPLAINed over a table of
			// other contacts (an empty table makes any index look as good): it
			// picks the contact index.
			await store.insertIgnore(
				Array.from({ length: 2_000 }, (_, i) =>
					row({ contactId: `other-${i}`, eventType: 'purchase.recorded' }),
				),
			)
			await pool.query('ANALYZE TABLE AI_DrovrOutbox')
			const sent: { query: string; params: unknown[] }[] = []
			const logged = createDrizzleDrovrOutboxStore(
				drizzle(pool, {
					schema: databaseSchema,
					mode: 'default',
					logger: {
						logQuery: (query: string, params: unknown[]) =>
							void sent.push({ query, params }),
					},
				}),
			)
			await logged.openGates({ target: PROD, contactIds: ['c1', 'c2'] })
			expect(sent).toHaveLength(1)
			const [plan] = (await pool.query(
				`EXPLAIN ${sent[0]!.query}`,
				sent[0]!.params,
			)) as unknown as [{ key: string | null }[]]
			expect(plan[0]?.key).toBe('DrovrOutbox_contact_idx')
		})

		it("pulls a contact's pending non-stop rows waiting for later back to now, on the contact index (round 3)", async () => {
			const now = '2026-09-30T12:00:00.000Z'
			const later = '2026-09-30T13:15:00.000Z'
			const earlier = '2026-09-30T11:55:00.000Z'
			// Rows the gate moved behind a stop carry its note (row 204c).
			const behind = (overrides: Partial<DrovrOutboxRow>) =>
				row({
					lastError: 'held behind a stop the outbox still owes',
					...overrides,
				})
			const moved = behind({
				contactId: 'c1',
				eventType: 'email.completed',
				nextAttemptAt: later,
			})
			const due = behind({
				contactId: 'c1',
				eventType: 'email.completed',
				nextAttemptAt: earlier,
			})
			const stop = behind({
				contactId: 'c1',
				eventType: 'purchase.recorded',
				nextAttemptAt: later,
			})
			const held = behind({
				contactId: 'c1',
				eventType: 'email.completed',
				status: 'held',
				nextAttemptAt: later,
			})
			const otherContact = behind({
				contactId: 'c2',
				eventType: 'email.completed',
				nextAttemptAt: later,
			})
			const otherTarget = behind({
				contactId: 'c1',
				eventType: 'email.completed',
				target: PREVIEW,
				nextAttemptAt: later,
			})
			// Waiting out its own backoff (drovr's Retry-After): keeps its time.
			const ownBackoff = row({
				contactId: 'c1',
				eventType: 'email.completed',
				nextAttemptAt: later,
			})
			await store.insertIgnore([
				moved,
				ownBackoff,
				due,
				stop,
				held,
				otherContact,
				otherTarget,
			])
			expect(
				await store.pullForward({ target: PROD, contactIds: ['c1'], now }),
			).toBe(1)
			const [found] = (await pool.query(
				'SELECT id, nextAttemptAt FROM AI_DrovrOutbox',
			)) as unknown as [{ id: string; nextAttemptAt: Date }[]]
			expect(
				Object.fromEntries(
					found.map((r) => [r.id, r.nextAttemptAt.toISOString()]),
				),
			).toEqual({
				[moved.id]: now,
				[ownBackoff.id]: later,
				[due.id]: earlier,
				[stop.id]: later,
				[held.id]: later,
				[otherContact.id]: later,
				[otherTarget.id]: later,
			})
			expect(
				await store.pullForward({ target: PROD, contactIds: [], now }),
			).toBe(0)
			// The statement the store really sends, EXPLAINed over an outage's
			// worth of other contacts' rows, all waiting for later: the case
			// where scanning by time would read them all.
			await store.insertIgnore(
				Array.from({ length: 2_000 }, (_, i) =>
					row({
						contactId: `other-${i}`,
						eventType: 'email.completed',
						nextAttemptAt: later,
					}),
				),
			)
			await pool.query('ANALYZE TABLE AI_DrovrOutbox')
			const sent: { query: string; params: unknown[] }[] = []
			await createDrizzleDrovrOutboxStore(
				drizzle(pool, {
					schema: databaseSchema,
					mode: 'default',
					logger: {
						logQuery: (query: string, params: unknown[]) =>
							void sent.push({ query, params }),
					},
				}),
			).pullForward({ target: PROD, contactIds: ['c1'], now })
			expect(sent).toHaveLength(1)
			const [plan] = (await pool.query(
				`EXPLAIN ${sent[0]!.query}`,
				sent[0]!.params,
			)) as unknown as [{ key: string | null }[]]
			expect(plan[0]?.key).toBe('DrovrOutbox_contact_idx')
		})

		it('holds only pending rows of this target by dedupe key: drovr refused the stop (row 204c)', async () => {
			const pending = row({ eventType: 'purchase.recorded' })
			const delivered = row({
				eventType: 'purchase.recorded',
				status: 'delivered',
			})
			const elsewhere = row({ eventType: 'purchase.recorded', target: PREVIEW })
			await store.insertIgnore([pending, delivered, elsewhere])
			const held = await store.holdPending({
				target: PROD,
				dedupeKeys: [
					pending.dedupeKey,
					delivered.dedupeKey,
					elsewhere.dedupeKey,
				],
				at: '2026-09-30T12:00:00.000Z',
				note: 'drovr refused the stop (404)',
				httpStatus: 404,
			})
			expect(held).toBe(1)
			const [rows] = (await pool.query(
				`SELECT id, status, lastError, lastStatus, lastAttemptAt FROM AI_DrovrOutbox ORDER BY id`,
			)) as unknown as [
				{
					id: string
					status: string
					lastError: string
					lastStatus: number
					lastAttemptAt: Date
				}[],
			]
			expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
				[pending.id]: 'held',
				[delivered.id]: 'delivered',
				[elsewhere.id]: 'pending',
			})
			expect(rows.find((r) => r.id === pending.id)).toMatchObject({
				lastError: 'drovr refused the stop (404)',
				lastStatus: 404,
			})
			expect(
				rows.find((r) => r.id === pending.id)?.lastAttemptAt.toISOString(),
			).toBe('2026-09-30T12:00:00.000Z')
			expect(
				await store.holdPending({
					target: PROD,
					dedupeKeys: [],
					at: '2026-09-30T12:00:00.000Z',
					note: null,
					httpStatus: null,
				}),
			).toBe(0)
		})

		it('reads held stops and deferred stops apart from the owed ones (row 204c)', async () => {
			const stop = (overrides: Partial<DrovrOutboxRow>) =>
				row({ eventType: 'contact.unsubscribed', ...overrides })
			await store.insertIgnore([
				stop({ firstFailedAt: '2026-09-30T08:00:00.000Z', status: 'held' }),
				stop({ firstFailedAt: '2026-09-30T09:00:00.000Z', status: 'held' }),
				stop({
					firstFailedAt: '2026-09-30T07:00:00.000Z',
					source: 'contactSync',
				}),
				stop({ firstFailedAt: '2026-09-30T10:00:00.000Z' }),
				stop({ firstFailedAt: '2026-09-30T06:00:00.000Z', target: PREVIEW }),
				row({ firstFailedAt: '2026-09-30T05:00:00.000Z', status: 'held' }),
			])
			expect(await store.depth(PROD)).toMatchObject({
				held: 3,
				heldStops: 2,
				oldestHeldStopFailedAt: '2026-09-30T08:00:00.000Z',
				oldestDeferredStopFailedAt: '2026-09-30T07:00:00.000Z',
				oldestOpenStopFailedAt: '2026-09-30T10:00:00.000Z',
			})
		})

		it('settles only pending rows of this target by dedupe key: a retry landed (row 204b)', async () => {
			const pending = row({ eventType: 'purchase.recorded' })
			const refused = row({
				eventType: 'purchase.recorded',
				status: 'rejected',
			})
			const elsewhere = row({ eventType: 'purchase.recorded', target: PREVIEW })
			await store.insertIgnore([pending, refused, elsewhere])
			const settled = await store.settlePending({
				target: PROD,
				dedupeKeys: [pending.dedupeKey, refused.dedupeKey, elsewhere.dedupeKey],
				at: '2026-09-30T12:00:00.000Z',
				note: 'delivered by an Inngest retry',
			})
			expect(settled).toBe(1)
			const [rows] = (await pool.query(
				`SELECT id, status, lastError FROM AI_DrovrOutbox ORDER BY id`,
			)) as unknown as [{ id: string; status: string; lastError: string }[]]
			expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
				[pending.id]: 'delivered',
				[refused.id]: 'rejected',
				[elsewhere.id]: 'pending',
			})
			expect(rows.find((r) => r.id === pending.id)?.lastError).toBe(
				'delivered by an Inngest retry',
			)
			expect(
				await store.settlePending({
					target: PROD,
					dedupeKeys: [],
					at: '2026-09-30T12:00:00.000Z',
					note: null,
				}),
			).toBe(0)
			const [plan] = (await pool.query(
				`EXPLAIN UPDATE AI_DrovrOutbox SET status = 'delivered' WHERE dedupeKey IN (?) AND target = ? AND status = 'pending'`,
				[pending.dedupeKey, PROD],
			)) as unknown as [{ key: string | null }[]]
			expect(plan[0]?.key).toBe('DrovrOutbox_dedupe_uq')
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
				oldestDeferredStopFailedAt: null,
				heldStops: 0,
				oldestHeldStopFailedAt: null,
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
