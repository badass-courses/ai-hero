import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { dueProfileConfirmations } from './contact-sync-restatement'
import { reserveBulkSlot, type PaceConnection, type BulkClass } from './drovr-bulk-pace'
import { createDrizzleBackfillApprovals } from './contact-sync-backfill-approval'
import { createDrizzleContactProfileVersionStore } from './contact-profile-version-drizzle'
import { createDrizzleValuePathLinkAnchorStore } from './drizzle-value-path-link-anchor'
import {
	resolveValuePathLinkAnchor,
	type ValuePathLinkAnchorStore,
} from './value-path-link-anchor'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

const key = {
	contactId: 'contact-mysql-anchor',
	valuePathSlug: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-0',
	fingerprint: 'f'.repeat(64),
}
const first = {
	issuedAt: '2026-09-26T16:00:00.123Z',
	expiresAt: '2027-01-24T16:00:00.123Z',
}

integration('contact-sync stores on MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let store: ValuePathLinkAnchorStore
	let versions: ReturnType<typeof createDrizzleContactProfileVersionStore>

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_link_anchor_test_${randomUUID().replaceAll('-', '')}`
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
		const migration = await fs.readFile(
			new URL(
				'../../db/migrations/20260926_ai_hero_contact_sync.sql',
				import.meta.url,
			),
			'utf8',
		)
		await pool.query(migration)
		// Rerunnable: the second apply skips all three tables.
		await pool.query(migration)
		const profileHash = await fs.readFile(
			new URL(
				'../../db/migrations/20260926_ai_hero_contact_profile_hash.sql',
				import.meta.url,
			),
			'utf8',
		)
		await pool.query(profileHash)
		await pool.query(profileHash)
		// Additive, guarded: runs twice without error.
		const acknowledged = await fs.readFile(
			new URL(
				'../../db/migrations/20260927_ai_hero_contact_profile_ack.sql',
				import.meta.url,
			),
			'utf8',
		)
		await pool.query(acknowledged)
		await pool.query(acknowledged)
		const database = drizzle(pool, { schema: databaseSchema, mode: 'default' })
		store = createDrizzleValuePathLinkAnchorStore(database)
		versions = createDrizzleContactProfileVersionStore(database)
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		await pool.query('DELETE FROM AI_ValuePathLinkAnchor')
		await pool.query('DELETE FROM AI_ContactProfileVersion')
	})

	it('creates the three contact-sync tables and nothing else', async () => {
		const [rows] = await pool.query(
			'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
		)
		expect((rows as { name: string }[]).map((row) => row.name)).toEqual([
			'AI_ContactProfileVersion',
			'AI_ContactSyncCursor',
			'AI_ValuePathLinkAnchor',
		])
	})

	it('stores a first issue in UTC and answers exists for a second insert', async () => {
		await expect(store.insert(key, first)).resolves.toBe('inserted')
		await expect(
			store.insert(key, {
				issuedAt: '2026-09-27T00:00:00.000Z',
				expiresAt: '2027-01-25T00:00:00.000Z',
			}),
		).resolves.toBe('exists')
		await expect(store.find(key)).resolves.toEqual(first)
		await expect(
			store.find({ ...key, fingerprint: 'e'.repeat(64) }),
		).resolves.toBeUndefined()
	})

	it('answers later windows from the first issue without rewriting the row', async () => {
		await expect(
			resolveValuePathLinkAnchor({ store, key, now: first.issuedAt }),
		).resolves.toEqual(first)
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2027-01-10T16:00:00.000Z',
			}),
		).resolves.toEqual({
			issuedAt: '2026-12-25T16:00:00.123Z',
			expiresAt: '2027-04-24T16:00:00.123Z',
		})
		await expect(store.find(key)).resolves.toEqual(first)
	})

	it('converges concurrent first issues on one row', async () => {
		const answers = await Promise.all(
			['2026-09-26T16:00:00.000Z', '2026-09-26T16:00:01.000Z'].map((now) =>
				resolveValuePathLinkAnchor({ store, key, now }),
			),
		)
		expect(answers[0]).toBeDefined()
		expect(answers[1]).toEqual(answers[0])
		const [rows] = await pool.query(
			'SELECT COUNT(*) AS n FROM AI_ValuePathLinkAnchor',
		)
		expect((rows as { n: number }[])[0]?.n).toBe(1)
	})

	it('versions a contact by content: same hash, same version and since; new hash, next version', async () => {
		let clock = '2026-09-26T18:00:00.000Z'
		const store = createDrizzleContactProfileVersionStore(
			drizzle(pool, { schema: databaseSchema, mode: 'default' }),
			{ now: () => clock },
		)
		await expect(store.versionFor('contact-v', 'hash-a')).resolves.toEqual({
			profileVersion: 1,
			since: '2026-09-26T18:00:00.000Z',
			acknowledged: false,
		})
		clock = '2026-09-26T18:15:00.000Z'
		await expect(store.versionFor('contact-v', 'hash-a')).resolves.toEqual({
			profileVersion: 1,
			since: '2026-09-26T18:00:00.000Z',
			acknowledged: false,
		})
		await expect(store.versionFor('contact-v', 'hash-b')).resolves.toEqual({
			profileVersion: 2,
			since: '2026-09-26T18:15:00.000Z',
			acknowledged: false,
		})
		const concurrent = await Promise.all(
			['c', 'd', 'e', 'f'].map((hash) =>
				versions.versionFor('contact-v', hash),
			),
		)
		expect(
			concurrent.map((version) => version.profileVersion).sort((a, b) => a - b),
		).toEqual([3, 4, 5, 6])
		const [rows] = await pool.query(
			"SELECT profileVersion AS v, profileHash AS h FROM AI_ContactProfileVersion WHERE contactId = 'contact-v'",
		)
		const row = (rows as { v: number; h: string }[])[0]
		expect(Number(row?.v)).toBe(6)
		expect(row?.h).toMatch(/^[c-f]$/)
	})

	it('moves acknowledgedAt on an equal-version confirmation, without changing since', async () => {
		let clock = '2032-01-01T00:00:00.000Z'
		const store = createDrizzleContactProfileVersionStore(drizzle(pool, { schema: databaseSchema, mode: 'default' }), { now: () => clock })
		await store.versionFor('confirmation', 'v2:' + 'a'.repeat(61))
		await store.acknowledge('confirmation', 1)
		clock = '2032-02-01T00:00:00.000Z'
		await store.acknowledge('confirmation', 1)
		const [rows] = await pool.query("SELECT acknowledgedAt AS at, updatedAt AS since, acknowledgedVersion AS version FROM AI_ContactProfileVersion WHERE contactId = 'confirmation'")
		const [row] = rows as { at: Date; since: Date; version: number }[]
		expect(row!.at.toISOString()).toBe(clock)
		expect(row!.since.toISOString()).toBe('2032-01-01T00:00:00.000Z')
		expect(Number(row!.version)).toBe(1)
	})

	it('migrates a proven matching legacy digest under concurrent writers without spending a version', async () => {
		const legacy = 'a'.repeat(64)
		const next = 'v2:' + 'b'.repeat(61)
		await versions.versionFor('migration', legacy)
		await versions.acknowledge('migration', 1)
		const before = await versions.currentFor('migration')
		const results = await Promise.all([versions.versionFor('migration', next, legacy), versions.versionFor('migration', next, legacy)])
		expect(results.map(row => row.profileVersion)).toEqual([1, 1])
		expect(await versions.currentFor('migration')).toMatchObject({ profileVersion: 1, contentHash: next, since: before!.since, acknowledged: true })
		await expect(versions.versionFor('migration', 'v2:' + 'c'.repeat(61), legacy)).resolves.toMatchObject({ profileVersion: 2, acknowledged: false })
	})

	it('reserves disjoint future slots under database contention, with a protected delta budget and UTC connections', async () => {
		await pool.query("DELETE FROM AI_ContactSyncCursor WHERE name = 'bulk-delivery-pace-v2'")
		const acquire = async () => await pool.getConnection() as unknown as PaceConnection
		const classes: BulkClass[] = [...Array<BulkClass>(12).fill('delta'), ...Array<BulkClass>(4).fill('restate'), 'ingest', 'ingest', 'ingest', 'backfill']
		const slots = await Promise.all(Array.from({ length: 300 }, (_, index) => reserveBulkSlot(acquire, 'AI_ContactSyncCursor', classes[index % classes.length]!)))
		const ordered = slots.sort((a, b) => a - b)
		expect(new Set(slots).size).toBe(slots.length)
		for (let i = 1; i < ordered.length; i++) expect(ordered[i]! - ordered[i - 1]!).toBeGreaterThanOrEqual(600)
		for (const at of slots) expect(slots.filter(other => other >= at && other < at + 60000).length).toBeLessThanOrEqual(100)
		// Exhausting background lookahead does not reserve or steal delta slots.
		await pool.query("UPDATE AI_ContactSyncCursor SET `cursor` = JSON_OBJECT('backfill', UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 + 900000) WHERE name = 'bulk-delivery-pace-v2'")
		await expect(reserveBulkSlot(acquire, 'AI_ContactSyncCursor', 'backfill')).rejects.toMatchObject({ name: 'RetryAfterError' })
		await expect(reserveBulkSlot(acquire, 'AI_ContactSyncCursor', 'delta')).resolves.toBeTypeOf('number')
	}, 30000)

	it('rotates the real oldest-first selector across acknowledged contacts without starving or acknowledging a pending version', async () => {
		let clock = '2032-01-01T00:00:00.000Z'
		const db = drizzle(pool, { schema: databaseSchema, mode: 'default' })
		const versions = createDrizzleContactProfileVersionStore(db, { now: () => clock })
		for (let index = 0; index < 12; index++) {
			await versions.versionFor(`due-${index}`, 'v2:' + 'd'.repeat(61))
			await versions.acknowledge(`due-${index}`, 1)
		}
		await versions.versionFor('pending', 'v2:' + 'e'.repeat(61))
		clock = '2032-02-05T00:00:00.000Z'
		const seen: string[] = []
		for (let tick = 0; tick < 12; tick++) {
			const due = await dueProfileConfirmations(db, Date.parse(clock), async () => { throw new Error('unexpected capacity') })
			expect(due).toHaveLength(1)
			seen.push(due[0]!.contactId)
			await versions.acknowledge(due[0]!.contactId, 1)
		}
		expect(new Set(seen).size).toBe(12)
		expect(seen).not.toContain('pending')
		expect(await dueProfileConfirmations(db, Date.parse(clock), async () => {})).toEqual([])
		expect((await versions.currentFor('pending'))!.acknowledged).toBe(false)
	})

	it('requires a single-use approval bound to the real count and exact cursor', async () => {
		const approvals = createDrizzleBackfillApprovals(drizzle(pool, { schema: databaseSchema, mode: 'default' }))
		const binding = { kind: 'continue' as const, rows: 7, cursor: { phase: 'owners' as const, afterId: 'cursor-a' } }
		const token = await approvals.issue(binding)
		expect(await approvals.consume(token, { ...binding, rows: 0 })).toBe(false)
		expect(await approvals.consume(token, { ...binding, cursor: { ...binding.cursor, afterId: 'cursor-b' } })).toBe(false)
		const claims = await Promise.all(Array.from({ length: 10 }, () => approvals.consume(token, binding)))
		expect(claims.filter(Boolean)).toHaveLength(1)
		expect(await approvals.consume(token, binding)).toBe(false)
		const expired = createDrizzleBackfillApprovals(drizzle(pool, { schema: databaseSchema, mode: 'default' }), () => Date.now() - 2 * 86400000)
		expect(await approvals.consume(await expired.issue(binding), binding)).toBe(false)
	})

	it('acknowledges a version without moving when it was set (so re-statements stay byte-identical)', async () => {
		const clock = '2026-09-26T18:00:00.000Z'
		const store = createDrizzleContactProfileVersionStore(
			drizzle(pool, { schema: databaseSchema, mode: 'default' }),
			{ now: () => clock },
		)
		await store.versionFor('contact-a', 'hash-a')
		// updatedAt has ON UPDATE CURRENT_TIMESTAMP and is the version's
		// since; an acknowledgement must not bump it.
		await new Promise((resolve) => setTimeout(resolve, 20))
		await store.acknowledge('contact-a', 1)
		await expect(store.versionFor('contact-a', 'hash-a')).resolves.toEqual({
			profileVersion: 1,
			since: '2026-09-26T18:00:00.000Z',
			acknowledged: true,
		})
		const [rows] = await pool.query(
			"SELECT acknowledgedVersion AS v, acknowledgedAt AS at FROM AI_ContactProfileVersion WHERE contactId = 'contact-a'",
		)
		const row = (rows as { v: number; at: unknown }[])[0]
		expect(Number(row?.v)).toBe(1)
		expect(row?.at).toBeTruthy()
		// A stale acknowledgement (after the content moved on) is a no-op.
		await expect(
			store.versionFor('contact-a', 'hash-b'),
		).resolves.toMatchObject({
			profileVersion: 2,
			acknowledged: false,
		})
		await store.acknowledge('contact-a', 1)
		await expect(
			store.versionFor('contact-a', 'hash-b'),
		).resolves.toMatchObject({
			profileVersion: 2,
			acknowledged: false,
		})
	})
})
