import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as databaseSchema from '@/db/schema'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

import { validateMySqlIntegrationServerUrl } from '../team-purchase-mysql-test-guard'
import { captureDrovrOutbox, drovrOutboxDedupeKey, outboxEntryForEvent, runDrovrOutboxReplay, type DrovrOutboxEntry } from './drovr-outbox'
import { contactProfileVersion } from '@/db/contact-sync-schema'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, eq, inArray } from 'drizzle-orm'
import { freezeProfileAckRequest } from './contact-sync-profile-ack'
import { settleAndCompleteProfileAck } from './contact-sync-profile-ack-persistence'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import { protectProfileAckPurge } from './contact-sync-profile-ack-purge'
import { createDrizzleDrovrOutboxStore, fromStored } from './drovr-outbox-drizzle'
import { postDrovrOutboxRow } from './drovr-outbox-replay-post'
import { queueCappedReplay } from './contact-sync-replay-queue'
import { BULK_OUTBOX_QUEUE_WAIT_MS } from './contact-sync-bulk'
import { deliverDrovrShadowEvent, type DrovrShadowEvent } from './drovr-shadow-emitter'
import { deliverBatchOrThrow, isNeverBornOwnerStop } from './drovr-shadow-delivery'

// The live wrappers against the real store: only the database handle and
// the logger and fail-closed rollout flag are stood in, so option plumbing
// is tested without any remote flag backend.
const live = vi.hoisted(() => ({ db: undefined as unknown, ackEnabled: vi.fn(async () => false) }))
vi.mock('./contact-sync-profile-ack-flag-live', () => ({ profileAckEnabled: live.ackEnabled }))
vi.mock('@/db', () => ({
	get db() {
		return live.db
	},
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
	captureDrovrOutboxLive,
	holdDrovrStopsLive,
	settleDrovrOutboxLive,
	drovrOutboxWorkStatesLive,
} from './drovr-outbox-live'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

const entry = (
	key: string,
	type: string,
	contactId = 'contact-1',
	journeyId = 'crash-course-evergreen-offer',
): DrovrOutboxEntry =>
	outboxEntryForEvent(
		{
			tenantId: 'org-aihero',
			contactId,
			journeyId: journeyId as 'crash-course-evergreen-offer',
			type: type as 'purchase.recorded',
			occurredAt: '2026-09-30T12:00:00.000Z',
			idempotencyKey: key,
		},
		'live',
	)

import { readOutboxQueueState } from './drovr-outbox-queue-state'
import { encodeHeldContinuationEnvelope, readHeldContinuationEnvelope } from './drovr-outbox-control'
import { recordOwnerStopRejectionLive } from './drovr-owner-stop-rejection-live'
import { buildContactProfileEvents } from './drovr-contact-profile-sync'
import { proveContactProfileDeliveryLive } from './contact-sync-profile-acknowledgement'
import { ACK_TOMBSTONE_BODY, type ProfileAckReference } from './contact-sync-profile-ack-schema'
import { ackTombstoneKey, ackTombstoneIdempotencyKey, makeAckTombstone, readAckTombstone, retainAckTombstone } from './contact-sync-ack-tombstone'
import { heldBatchRowsLive, heldBatchPersistenceLive } from './contact-sync-held-batch-drizzle'
import { inspectHeldBatchesLive } from './contact-sync-held-batch-live'

type Stored = {
	idempotencyKey: string
	status: string
	attempts: number
	nextAttemptAt: Date
	firstFailedAt: Date
	lastError: string | null
	heldContinuation: unknown
	target: string
}

integration('the live outbox wrappers on MySQL (row 204b round 3)', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_drovr_outbox_live_${randomUUID().replaceAll('-', '')}`
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
		// Existing core schema, never a production migration from this test.
		await pool.query(await fs.readFile(new URL('../../db/migrations/20260504_ai_hero_subscriber_marketing_gate_a.sql', import.meta.url), 'utf8'))
		const acquire = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(await acquire())) as typeof pool.getConnection
		await pool.query(
			await fs.readFile(
				new URL(
					'../../db/migrations/20260930_ai_hero_drovr_outbox.sql',
					import.meta.url,
				),
				'utf8',
			),
		)
		await pool.query(await fs.readFile(new URL('../../db/migrations/20261016_ai_hero_drovr_held_continuation.sql', import.meta.url), 'utf8'))
		for (const migration of ['20260926_ai_hero_contact_sync.sql', '20260926_ai_hero_contact_profile_hash.sql', '20260927_ai_hero_contact_profile_ack.sql'])
			await pool.query(await fs.readFile(new URL(`../../db/migrations/${migration}`, import.meta.url), 'utf8'))
		live.db = drizzle(pool, { schema: databaseSchema, mode: 'default' })
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		live.ackEnabled.mockReset().mockResolvedValue(false)
		vi.stubEnv('VERCEL_ENV', 'production')
		await pool.query('DELETE FROM AI_DrovrOutbox')
		await pool.query('DELETE FROM AI_ContactEvent')
		await pool.query('DELETE FROM AI_ContactProfileVersion')
	})

	const rows = async () => {
		const [found] = (await pool.query(
			'SELECT idempotencyKey, status, attempts, nextAttemptAt, firstFailedAt, lastError, heldContinuation, target FROM AI_DrovrOutbox ORDER BY idempotencyKey',
		)) as unknown as [Stored[]]
		return new Map(found.map((row) => { const queue = readOutboxQueueState(row.heldContinuation, row.lastError); return [row.idempotencyKey, { ...row, lastError: queue.diagnostic, queueHandoffs: queue.handoffs, queueMetadataInvalid: queue.invalid, queuePublicationId: queue.publicationId }] as const }))
	}
	const insertLift = () => pool.query("INSERT INTO AI_ContactEvent (id, contactId, providerIdentityId, provider, providerEventId, providerReference, eventType, semanticIdempotencyKey, privacyLevel, identityEvidence, payloadSummary, schemaVersion, occurredAt) VALUES ('n11:lift', 'contact-1', 'synthetic-identity', 'synthetic', 'synthetic-provider-event', 'synthetic-reference', 'contact.resubscribed', 'n11:lift', 'internal', JSON_OBJECT(), JSON_OBJECT(), 1, '2026-09-30 12:01:00')")

	const profileProofInput = () => ({
		contactId: 'synthetic-proof-contact', profileVersion: 3,
		events: buildContactProfileEvents({ contactId: 'synthetic-proof-contact', profileVersion: 3, occurredAt: '2026-09-30T12:00:00.000Z', profile: { email: 'synthetic@example.test', firstName: null, holds: [] }, links: [{ journeyId: 'value-path-skills-course', emailKey: 'synthetic-message', issuedAt: '2026-09-30T12:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', variables: {}, sendTimeFields: [] }], offers: [] }),
	})
	const atomicDb = () => live.db as typeof import('@/db').db
	const atomicRows = async () => (await atomicDb().select().from(drovrOutbox).where(and(eq(drovrOutbox.contactId, 'synthetic-atomic-ack'), inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES])))).map(fromStored)
	const atomicVersion = async () => (await atomicDb().select().from(contactProfileVersion).where(eq(contactProfileVersion.contactId, 'synthetic-atomic-ack')))[0]!
	async function seedAtomicAck(period?: string, linkCount = 1) {
		const clock = period ? `${period}-01T00:00:00.000Z` : '2032-01-01T00:00:00.000Z'
		const events = buildContactProfileEvents({ contactId: 'synthetic-atomic-ack', profileVersion: 3, occurredAt: clock,
			profile: { email: 'synthetic-atomic@example.test', firstName: null, holds: [] },
			links: period ? [] : Array.from({ length: linkCount }, (_, index) => ({ journeyId: 'value-path-skills-course', emailKey: `synthetic-${index}`, issuedAt: clock, expiresAt: '2032-05-01T00:00:00.000Z', variables: {}, sendTimeFields: [] })), offers: [] })
		if (period) events[0]!.idempotencyKey += `:restate:${period}`
		const entries = events.map(event => outboxEntryForEvent(event, period ? 'bulkRestate' : 'bulkDelta'))
		expect(await captureDrovrOutbox({ store: createDrizzleDrovrOutboxStore(live.db), target: 'production', entries, reason: 'synthetic atomic ACK fixture', now: new Date(clock), log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } })).toMatchObject({ status: 'outboxed' })
		const wanted = new Set(entries.map(item => drovrOutboxDedupeKey('production', item)))
		const native = (await atomicRows()).filter(row => wanted.has(row.dedupeKey))
		const state = freezeProfileAckRequest({ target: 'production', contactId: 'synthetic-atomic-ack', profileVersion: 3, registeredAt: clock, rows: native })
		for (const row of native)
			await pool.execute('UPDATE AI_DrovrOutbox SET heldContinuation = ? WHERE id = ?', [encodeHeldContinuationEnvelope({ v: 1, replayProof: { v: 1, handoffs: 2 }, profileAck: row.dedupeKey === state.ref.coordinatorKey ? state : { v: 1, role: 'member', ref: state.ref } }), row.id])
		await pool.execute('INSERT IGNORE INTO AI_ContactProfileVersion (contactId, profileVersion, profileHash, updatedAt) VALUES (?, 3, ?, ?)', ['synthetic-atomic-ack', 'v2:synthetic-atomic', clock.slice(0, 23).replace('T', ' ')])
		const settle = (keys: string[], database: unknown = live.db, enabled = async () => true) => settleAndCompleteProfileAck({ database, ref: state.ref, settledKeys: keys, enabled,
			settle: async transaction => {
				const tx = transaction as typeof import('@/db').db
				const result = await tx.update(drovrOutbox).set({ status: 'delivered', deliveredAt: '2032-03-20 00:00:00.000', lastAttemptAt: '2032-03-20 00:00:00.000', lastStatus: 202 }).where(and(eq(drovrOutbox.target, 'production'), inArray(drovrOutbox.dedupeKey, keys), inArray(drovrOutbox.status, ['pending', 'deferred'])))
				const header = Array.isArray(result) ? result[0] : result
				return Number((header as unknown as { affectedRows: number }).affectedRows)
			} })
		return { state, settle, keys: [...wanted] }
	}
	async function seedAtomicFailureTombstone(ref: ProfileAckReference, expired = false) {
		let state = makeAckTombstone(ref, { createdAt: '2032-03-01T00:00:00.000Z', reason: 'ack-write-failed' })
		if (expired) state = retainAckTombstone(state, makeAckTombstone(ref, { createdAt: '2032-03-02T00:00:00.000Z', reason: 'expired-evidence' }))
		const clock = state.createdAt.slice(0, 23).replace('T', ' ')
		await pool.execute(`INSERT INTO AI_DrovrOutbox (id, dedupeKey, target, endpoint, tenantId, contactId, journeyId, eventType, idempotencyKey, body, needsFanOut, source, status, attempts, occurredAt, firstFailedAt, nextAttemptAt, createdAt, heldContinuation)
			VALUES (?, ?, ?, 'control', ?, ?, ?, 'profile.ack.tombstone', ?, ?, 0, 'ackTombstone', 'ackTombstone', 0, ?, ?, ?, ?, ?)`,
			['synthetic-atomic-failure', ackTombstoneKey(ref), ref.target, ref.tenantId, ref.contactId, ref.journeyId, ackTombstoneIdempotencyKey(ref), JSON.stringify(ACK_TOMBSTONE_BODY), clock, clock, clock, clock, encodeHeldContinuationEnvelope({ v: 1, profileAck: state })])
	}
	it('real native replay carries the frozen SDK reference outside the unchanged body without re-registering it', async () => {
		const f = await seedAtomicAck()
		const profile = (await atomicRows()).find(row => row.eventType === 'contact.profile.updated')!
		const store = createDrizzleDrovrOutboxStore(live.db), send = vi.fn(async () => {})
		const now = Date.parse('2032-03-21T00:00:00.000Z')
		expect(await queueCappedReplay(profile, send, now, (until, expectedUntil, publicationId) => store.leaseQueue({ target: 'production', id: profile.id, nextAttemptAt: until, publicationId, ...(expectedUntil ? { expectedUntil } : { dueAt: new Date(now).toISOString() }) }), publicationId => store.abortQueueHandoff({ target: 'production', id: profile.id, publicationId }))).toMatchObject({ kind: 'queued', phase: 'published' })
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ profileAckRef: f.state.ref, profileAckNativeDebt: true, events: [profile.body], firstFailedAt: profile.firstFailedAt }) }))
		const retained = (await atomicRows()).find(row => row.dedupeKey === profile.dedupeKey)!
		expect(retained.body).toEqual(profile.body)
		expect(readHeldContinuationEnvelope(retained.heldContinuation)!.profileAck).toEqual(f.state)
		expect(live.ackEnabled).not.toHaveBeenCalled()
	})
	it('the actual live settlement port distinguishes partial native acceptance from a completed frozen ACK', async () => {
		const f = await seedAtomicAck()
		live.ackEnabled.mockResolvedValue(true)
		const evidence = { receiverAccepted: true, profileAckRef: f.state.ref }
		const native = await atomicRows(), profile = native.find(row => row.eventType === 'contact.profile.updated')!, link = native.find(row => row.eventType === 'contact.links.issued')!
		await expect(settleDrovrOutboxLive([profile, link], 'not one physical native request', evidence)).rejects.toThrow('one matching frozen profile/link member')
		expect(live.ackEnabled).not.toHaveBeenCalled()
		expect((await atomicRows()).every(row => row.status === 'pending')).toBe(true)
		expect(await settleDrovrOutboxLive([profile], 'actual SDK profile accepted', evidence)).toEqual({ _tag: 'ProfileAckAwaitingProof' })
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		expect(await settleDrovrOutboxLive([link], 'actual SDK original link accepted', evidence)).toBe(1)
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
	})
	it('the actual live settlement port returns typed expiry while preserving and settling surviving native debt', async () => {
		const f = await seedAtomicAck()
		live.ackEnabled.mockResolvedValue(true)
		await pool.execute("DELETE FROM AI_DrovrOutbox WHERE eventType = 'contact.links.issued' AND contactId = ?", [f.state.ref.contactId])
		const profile = (await atomicRows())[0]!
		expect(await settleDrovrOutboxLive([profile], 'actual surviving native profile accepted', { receiverAccepted: true, profileAckRef: f.state.ref })).toMatchObject({ _tag: 'AckEvidenceExpired' })
		expect((await atomicRows())[0]!.status).toBe('delivered')
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('real SQL SDK admission returns terminal expiry without recapture; retained native debt is still independently owed', async () => {
		const f = await seedAtomicAck()
		const { guardProfileAckWorkerAdmission } = await import('./contact-sync-profile-ack-admission')
		const profile = (await atomicRows()).find(row => row.eventType === 'contact.profile.updated')!
		const args = { database: live.db, target: 'production', ref: f.state.ref, events: [profile.body as DrovrShadowEvent] }
		await expect(guardProfileAckWorkerAdmission(args)).resolves.toBeUndefined()
		await pool.execute("DELETE FROM AI_DrovrOutbox WHERE eventType = 'contact.links.issued' AND contactId = ?", [f.state.ref.contactId])
		const before = await atomicDb().select().from(drovrOutbox)
		expect(await guardProfileAckWorkerAdmission(args)).toMatchObject({ _tag: 'AckEvidenceExpired' })
		await expect(guardProfileAckWorkerAdmission({ ...args, nativeDebt: true })).resolves.toBeUndefined()
		expect(await atomicDb().select().from(drovrOutbox)).toEqual(before)
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		await pool.execute('DELETE FROM AI_DrovrOutbox WHERE contactId = ?', [f.state.ref.contactId])
		expect(await guardProfileAckWorkerAdmission({ ...args, nativeDebt: true })).toMatchObject({ _tag: 'AckEvidenceExpired' })
	})
	it('SDK admission refuses the real later 129th-member SQL chunk when its required column disappears', async () => {
		const f = await seedAtomicAck(undefined, 128)
		const { guardProfileAckWorkerAdmission } = await import('./contact-sync-profile-ack-admission')
		const profile = (await atomicRows()).find(row => row.eventType === 'contact.profile.updated')!
		let selects = 0
		const faulty = new Proxy(atomicDb(), { get(target, key) {
			if (key === 'select') return (...args: unknown[]) => {
				if (++selects === 3) throw { code: 'ER_BAD_FIELD_ERROR', errno: 1054, message: "Unknown column 'heldContinuation'" }
				return target.select(...args as [])
			}
			const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
		} })
		await expect(guardProfileAckWorkerAdmission({ database: faulty, target: 'production', ref: f.state.ref, events: [profile.body as DrovrShadowEvent] })).rejects.toThrow('heldContinuation')
		expect(selects).toBe(3)
		expect((await atomicRows()).every(row => row.status === 'pending')).toBe(true)
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('ACK-only worker completion uses only fresh stored proof and frozen clocks, never a legacy timestamp', async () => {
		const f = await seedAtomicAck()
		const { completeProfileAckWorkerReference } = await import('./contact-sync-profile-ack-completion-live')
		const args = { database: live.db, ref: f.state.ref, enabled: async () => true }
		expect(await completeProfileAckWorkerReference(args)).toEqual({ _tag: 'ProfileAckAwaitingProof' })
		await pool.execute("UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = '2032-03-20 00:00:00.000', lastAttemptAt = '2032-03-20 00:00:00.000', lastStatus = 202 WHERE contactId = ?", [f.state.ref.contactId])
		await expect(completeProfileAckWorkerReference(args)).resolves.toBeUndefined()
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
		await expect(completeProfileAckWorkerReference(args)).resolves.toBeUndefined()
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
		await pool.execute('DELETE FROM AI_DrovrOutbox WHERE contactId = ?', [f.state.ref.contactId])
		expect(await completeProfileAckWorkerReference(args)).toMatchObject({ _tag: 'AckEvidenceExpired' })
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
	})
	it('legacy ACK callbacks cannot refresh known frozen ages or bypass incomplete metadata when OFF', async () => {
		const f = await seedAtomicAck()
		const { createDrizzleContactProfileVersionStore } = await import('./contact-profile-version-drizzle')
		const versions = createDrizzleContactProfileVersionStore(live.db, { profileAckEnabled: async () => false, target: 'production', now: () => '2032-03-21T00:00:00.000Z' })
		await versions.acknowledge(f.state.ref.contactId, 3)
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		await f.settle(f.keys)
		await versions.acknowledge(f.state.ref.contactId, 3)
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
		await pool.execute('DELETE FROM AI_DrovrOutbox WHERE contactId = ?', [f.state.ref.contactId])
		await createDrizzleContactProfileVersionStore(live.db, { profileAckEnabled: async () => true, target: 'production', now: () => '2032-03-22T00:00:00.000Z' }).acknowledge(f.state.ref.contactId, 3)
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
	})
	it('actual worker settlement and direct replay patch share atomic frozen-clock completion', async () => {
		const f = await seedAtomicAck()
		const store = createDrizzleDrovrOutboxStore(live.db, { profileAckEnabled: async () => true })
		expect(await store.settlePending({ target: 'production', dedupeKeys: [f.state.ref.coordinatorKey], at: '2032-03-20T00:00:00.000Z', note: 'synthetic actual receiver acceptance', receiverAccepted: true })).toBe(1)
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		const link = (await atomicRows()).find(row => row.eventType === 'contact.links.issued')!
		await store.update(link.id, { status: 'delivered', deliveredAt: '2032-03-20T00:00:00.000Z', lastAttemptAt: '2032-03-20T00:00:00.000Z', lastStatus: 202 })
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
		expect((await atomicRows()).every(row => row.status === 'delivered')).toBe(true)
		const root = (await atomicRows()).find(row => row.dedupeKey === f.state.ref.coordinatorKey)!
		expect(readHeldContinuationEnvelope(root.heldContinuation)?.profileAck).toMatchObject({ role: 'coordinator', completion: { confirmationClock: '2032-01-01T00:00:00.000Z' } })
	})
	it('worker refusal hints never become native delivered evidence, even across ON/OFF; actual acceptance can settle while OFF', async () => {
		const f = await seedAtomicAck()
		let enabled = true
		const store = createDrizzleDrovrOutboxStore(live.db, { profileAckEnabled: async () => enabled })
		for (const value of [true, false]) {
			enabled = value
			expect(await store.settlePending({ target: 'production', dedupeKeys: f.keys, at: '2032-03-20T00:00:00.000Z', note: 'opaque prose falsely claiming acceptance', receiverAccepted: false })).toBe(0)
			expect((await atomicRows()).every(row => row.status === 'pending')).toBe(true)
		}
		expect(await store.settlePending({ target: 'production', dedupeKeys: f.keys, at: '2032-03-20T00:00:00.000Z', note: 'synthetic actual acceptance OFF', receiverAccepted: true })).toBe(2)
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		enabled = true
		await store.settlePending({ target: 'production', dedupeKeys: f.keys, at: '2032-03-21T00:00:00.000Z', note: 'synthetic retained positive receipts', receiverAccepted: true })
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
	})
	it('actual direct replay rolls native settlement back on ACK failure and respects a later held row', async () => {
		const f = await seedAtomicAck()
		await f.settle([f.state.ref.coordinatorKey])
		const link = (await atomicRows()).find(row => row.eventType === 'contact.links.issued')!
		const faulty = new Proxy(atomicDb(), { get(target, key) {
			if (key === 'transaction') return (run: (tx: unknown) => Promise<unknown>) => target.transaction(tx => run(new Proxy(tx, { get(t, k) {
				if (k === 'update') return (table: unknown) => {
					if (table === contactProfileVersion) throw new Error('synthetic worker ACK failure')
					return t.update(table as typeof drovrOutbox)
				}
				const value = Reflect.get(t, k); return typeof value === 'function' ? value.bind(t) : value
			} })))
			const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
		} })
		const patch = { status: 'delivered' as const, deliveredAt: '2032-03-20T00:00:00.000Z', lastStatus: 202 }
		await expect(createDrizzleDrovrOutboxStore(faulty, { profileAckEnabled: async () => true }).update(link.id, patch)).rejects.toThrow('synthetic worker ACK failure')
		expect((await atomicRows()).find(row => row.id === link.id)?.status).toBe('pending')
		const store = createDrizzleDrovrOutboxStore(live.db, { profileAckEnabled: async () => true })
		await store.update(link.id, { status: 'held' })
		await store.update(link.id, patch)
		expect((await atomicRows()).find(row => row.id === link.id)?.status).toBe('held')
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('ON then OFF or unknown refuses the WHOLE purge tick; back ON tombstones before deleting evidence', async () => {
		const f = await seedAtomicAck()
		await f.settle([f.state.ref.coordinatorKey]) // Registered ON; native link debt still pending.
		await captureDrovrOutboxLive([entry('synthetic-unrelated-old-receipt', 'purchase.recorded')], 'synthetic old receipt')
		await pool.execute("UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = '2032-03-20 00:00:00.000' WHERE idempotencyKey = 'synthetic-unrelated-old-receipt'")
		const snapshot = () => atomicDb().select().from(drovrOutbox).orderBy(drovrOutbox.id)
		const before = JSON.stringify(await snapshot())
		const enabled = vi.fn(async () => false)
		const store = createDrizzleDrovrOutboxStore(live.db, { profileAckEnabled: enabled })
		const expected = { _tag: 'PurgeRefused', v: 1, reason: 'profile-ack-protection-flag-off', protectedRows: 1, candidateRows: 2 }
		expect(await store.deleteDeliveredBefore('2032-03-28T00:00:00.000Z', 2000)).toEqual(expected)
		expect(JSON.stringify(await snapshot())).toBe(before)
		enabled.mockImplementation(async () => { throw new Error('unknown flag') })
		expect(await store.deleteDeliveredBefore('2032-03-28T00:00:00.000Z', 2000)).toEqual(expected)
		expect(JSON.stringify(await snapshot())).toBe(before)
		expect(enabled).toHaveBeenCalledTimes(2) // Next tick only, never a hot loop.
		enabled.mockResolvedValue(true)
		expect(await store.deleteDeliveredBefore('2032-03-28T00:00:00.000Z', 2000)).toBe(2)
		const marker = (await snapshot()).find(row => row.status === 'ackTombstone')!
		expect(readAckTombstone(marker).reason).toBe('expired-evidence')
		expect((await atomicRows()).map(row => row.status)).toEqual(['pending'])
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('an explicit real native drain ends protection so OFF purge can resume without a tombstone', async () => {
		const f = await seedAtomicAck()
		await f.settle([f.state.ref.coordinatorKey])
		const store = createDrizzleDrovrOutboxStore(live.db, { profileAckEnabled: async () => false })
		expect(await store.deleteDeliveredBefore('2032-03-28T00:00:00.000Z', 2000)).toMatchObject({ _tag: 'PurgeRefused' })
		await f.settle(f.keys) // Operator-restored ON, actual remaining acceptance, not metadata stripping.
		expect(await store.deleteDeliveredBefore('2032-03-28T00:00:00.000Z', 2000)).toBe(2)
		expect(await atomicDb().select().from(drovrOutbox)).toHaveLength(0)
	})
	it('crash cuts before/after native DELETE roll both sides back, and committed purge has a prior tombstone', async () => {
		const f = await seedAtomicAck()
		await pool.execute("UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = '2032-03-20 00:00:00.000'")
		for (const crash of ['before-delete', 'after-delete', 'commit'] as const) {
			const run = () => atomicDb().transaction(async tx => {
				const candidates = await tx.select().from(drovrOutbox).where(eq(drovrOutbox.status, 'delivered')).orderBy(drovrOutbox.dedupeKey).for('update')
				return protectProfileAckPurge({ transaction: tx, candidates, enabled: async () => true, deleteCandidates: async () => {
					const saved = await tx.select().from(drovrOutbox).where(eq(drovrOutbox.dedupeKey, ackTombstoneKey(f.state.ref)))
					expect(saved).toHaveLength(1) // Assertion-kills DELETE-before-tombstone ordering.
					if (crash === 'before-delete') throw new Error('synthetic before-delete crash')
					await tx.delete(drovrOutbox).where(inArray(drovrOutbox.id, candidates.map(row => row.id)))
					if (crash === 'after-delete') throw new Error('synthetic after-delete crash')
					return candidates.length
				} })
			})
			if (crash === 'commit') expect(await run()).toBe(2)
			else {
				await expect(run()).rejects.toThrow(`synthetic ${crash} crash`)
				expect(await atomicRows()).toHaveLength(2)
				expect(await atomicDb().select().from(drovrOutbox).where(eq(drovrOutbox.status, 'ackTombstone'))).toHaveLength(0)
			}
		}
		expect(await atomicRows()).toHaveLength(0)
		const [marker] = await atomicDb().select().from(drovrOutbox)
		expect(readAckTombstone(marker!).reason).toBe('expired-evidence')
	})
	it('removes an earlier failed-ACK marker only with a complete committed native proof', async () => {
		const f = await seedAtomicAck()
		await seedAtomicFailureTombstone(f.state.ref)
		expect(await f.settle(f.keys)).toMatchObject({ disposition: 'acknowledged' })
		expect(await atomicRows()).toHaveLength(2)
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
	})
	it('rolls native work, ACK and completion back if removal of the prior failure marker fails', async () => {
		const f = await seedAtomicAck()
		await seedAtomicFailureTombstone(f.state.ref)
		const faulty = { transaction: (run: (tx: unknown) => Promise<unknown>) => atomicDb().transaction(tx => run(new Proxy(tx, {
			get(target, property) {
				if (property === 'delete') return () => { throw new Error('synthetic marker deletion failed') }
				const value = Reflect.get(target, property)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}))) }
		await expect(f.settle(f.keys, faulty)).rejects.toThrow('synthetic marker deletion failed')
		expect((await atomicRows()).every(row => row.status === 'pending')).toBe(true)
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		expect(await atomicDb().select().from(drovrOutbox).where(eq(drovrOutbox.dedupeKey, ackTombstoneKey(f.state.ref)))).toHaveLength(1)
		await f.settle(f.keys)
		expect(await atomicDb().select().from(drovrOutbox).where(eq(drovrOutbox.dedupeKey, ackTombstoneKey(f.state.ref)))).toHaveLength(0)
	})
	it('never revives a purged-evidence fence even if matching bodies are later available again', async () => {
		const f = await seedAtomicAck()
		await seedAtomicFailureTombstone(f.state.ref, true)
		expect(await f.settle(f.keys)).toMatchObject({ evaluation: { _tag: 'AckEvidenceExpired' } })
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		const markers = await atomicDb().select().from(drovrOutbox).where(eq(drovrOutbox.dedupeKey, ackTombstoneKey(f.state.ref)))
		expect(markers).toHaveLength(1)
		expect(readAckTombstone(markers[0]!).evidenceExpired).toBe(true)
	})
	it('atomically settles every frozen member and ages Jan1 profiles from Jan1 even when accepted March20', async () => {
		const f = await seedAtomicAck()
		expect(await f.settle([f.state.ref.coordinatorKey])).toMatchObject({ _tag: 'ProfileAckSettled', evaluation: { _tag: 'ProfileAckWaiting' } })
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		const link = f.keys.find(key => key !== f.state.ref.coordinatorKey)!
		expect(await f.settle([link])).toMatchObject({ disposition: 'acknowledged', evaluation: { _tag: 'ProfileAckReady', proof: { confirmationClock: '2032-01-01T00:00:00.000Z', provedAt: '2032-03-20T00:00:00.000Z' } } })
		const version = await atomicVersion()
		expect(version.acknowledgedVersion).toBe(3)
		expect(version.acknowledgedAt).toBe('2032-01-01 00:00:00.000')
		expect(version.updatedAt).toBe('2032-01-01 00:00:00.000')
		const native = await atomicRows()
		expect(native).toHaveLength(2) // Normal success creates NO metadata row.
		expect(native.every(row => row.status === 'delivered')).toBe(true)
		const envelope = readHeldContinuationEnvelope(native.find(row => row.dedupeKey === f.state.ref.coordinatorKey)!.heldContinuation)!
		expect(envelope.replayProof).toEqual({ v: 1, handoffs: 2 })
		expect(envelope.profileAck).toMatchObject({ role: 'coordinator', completion: { confirmationClock: '2032-01-01T00:00:00.000Z', provedAt: '2032-03-20T00:00:00.000Z', disposition: 'acknowledged' } })
		const first = JSON.stringify(native), firstVersion = JSON.stringify(version)
		expect(await f.settle([link])).toMatchObject({ settled: 0, evaluation: { alreadyCompleted: true } })
		expect(JSON.stringify(await atomicRows())).toBe(first)
		expect(JSON.stringify(await atomicVersion())).toBe(firstVersion)
	})
	it('rolls native settlement and first proof back on a failed ACK write, then reads fresh evidence on retry', async () => {
		const f = await seedAtomicAck()
		await f.settle([f.state.ref.coordinatorKey])
		const link = f.keys.find(key => key !== f.state.ref.coordinatorKey)!
		const faulty = { transaction: (run: (tx: unknown) => Promise<unknown>) => atomicDb().transaction(tx => run(new Proxy(tx, { get(target, property) {
			if (property === 'update') return (table: unknown) => {
				if (table === contactProfileVersion) throw new Error('synthetic version ACK write failed')
				return target.update(table as typeof drovrOutbox)
			}
			const value = Reflect.get(target, property)
			return typeof value === 'function' ? value.bind(target) : value
		} }))) }
		await expect(f.settle([link], faulty)).rejects.toThrow('synthetic version ACK write failed')
		expect((await atomicRows()).find(row => row.dedupeKey === link)!.status).toBe('pending')
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		await pool.execute("UPDATE AI_DrovrOutbox SET status = 'held' WHERE dedupeKey = ?", [f.state.ref.coordinatorKey])
		expect(await f.settle([link])).toMatchObject({ evaluation: { _tag: 'ProfileAckWaiting', reason: 'blocked' } })
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
		expect(readHeldContinuationEnvelope((await atomicRows()).find(row => row.dedupeKey === f.state.ref.coordinatorKey)!.heldContinuation)!.profileAck).not.toHaveProperty('completion')
	})
	it('serializes concurrent final-member proofs and retains one immutable first completion', async () => {
		const f = await seedAtomicAck()
		const outcomes = await Promise.all(f.keys.map(key => f.settle([key])))
		expect(outcomes.filter(result => 'disposition' in result && result.disposition === 'acknowledged')).toHaveLength(1)
		const before = JSON.stringify(await atomicRows())
		await Promise.all(f.keys.map(key => f.settle([key])))
		expect(JSON.stringify(await atomicRows())).toBe(before)
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-01-01 00:00:00.000')
	})
	it('refuses a conflicting delivered proof without refreshing the first completion', async () => {
		const f = await seedAtomicAck()
		await f.settle(f.keys)
		const before = JSON.stringify(await atomicVersion())
		await pool.execute("UPDATE AI_DrovrOutbox SET deliveredAt = '2032-03-21 00:00:00.000' WHERE dedupeKey = ?", [f.keys[0]!])
		await expect(f.settle(f.keys)).rejects.toThrow('different delivered proof')
		expect(JSON.stringify(await atomicVersion())).toBe(before)
	})
	it('records complete obsolete-version proof without acknowledging the newer profile', async () => {
		const f = await seedAtomicAck()
		await pool.execute('UPDATE AI_ContactProfileVersion SET profileVersion = 4 WHERE contactId = ?', [f.state.ref.contactId])
		expect(await f.settle(f.keys)).toMatchObject({ disposition: 'version-superseded' })
		expect((await atomicVersion()).acknowledgedVersion).toBeNull()
		expect((await atomicVersion()).profileVersion).toBe(4)
	})
	it('terminally expires missing ACK evidence while still settling actually accepted retained native debt', async () => {
		const f = await seedAtomicAck()
		const missing = f.keys.find(key => key !== f.state.ref.coordinatorKey)!
		await pool.execute('DELETE FROM AI_DrovrOutbox WHERE dedupeKey = ?', [missing])
		expect(await f.settle([f.state.ref.coordinatorKey])).toMatchObject({ evaluation: { _tag: 'AckEvidenceExpired' } })
		expect((await atomicRows()).map(row => row.status)).toEqual(['delivered'])
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('treats two monthly periods as distinct and replay of an older completed period as a no-op', async () => {
		const first = await seedAtomicAck('2032-01')
		await first.settle(first.keys)
		const second = await seedAtomicAck('2032-02')
		await second.settle(second.keys)
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-02-01 00:00:00.000')
		expect(await first.settle(first.keys)).toMatchObject({ evaluation: { alreadyCompleted: true } })
		expect((await atomicVersion()).acknowledgedAt).toBe('2032-02-01 00:00:00.000')
		const incompleteOld = await seedAtomicAck('2031-12')
		await expect(incompleteOld.settle(incompleteOld.keys)).rejects.toThrow('CONFIRMATION CLOCK WOULD MOVE BACKWARD')
		expect((await atomicRows()).find(row => row.dedupeKey === incompleteOld.keys[0])!.status).toBe('pending')
	})
	it('returns terminal expiry after all evidence is purged without invoking a mutation callback', async () => {
		const f = await seedAtomicAck()
		await pool.execute('DELETE FROM AI_DrovrOutbox WHERE contactId = ?', [f.state.ref.contactId])
		const settle = vi.fn(async () => { throw new Error('expired attempt mutated native work') })
		expect(await settleAndCompleteProfileAck({ database: live.db, ref: f.state.ref, settledKeys: f.keys, settle, enabled: async () => true })).toMatchObject({ settled: 0, evaluation: { _tag: 'AckEvidenceExpired' } })
		expect(settle).not.toHaveBeenCalled()
		expect(await atomicRows()).toEqual([])
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('requires the control column on the last post-settlement proof chunk and rolls back a late 1054', async () => {
		const f = await seedAtomicAck(undefined, 128)
		const last = f.keys[f.keys.length - 1]!
		await pool.execute("UPDATE AI_DrovrOutbox SET status = 'delivered', deliveredAt = '2032-03-20 00:00:00.000' WHERE dedupeKey <> ?", [last])
		let nativeReads = 0
		const wrapQuery = (query: object, native = false): object => new Proxy(query, {
			get(target, property) {
				const value = Reflect.get(target, property)
				if (typeof value !== 'function') return value
				return (...args: unknown[]) => {
					if (property === 'from' && args[0] === drovrOutbox) {
						native = true
						nativeReads += 1
					}
					if (property === 'for' && native && nativeReads === 6)
						return Promise.reject(Object.assign(new Error("Unknown column 'heldContinuation' in field list"), { code: 'ER_BAD_FIELD_ERROR', errno: 1054 }))
					const result = Reflect.apply(value, target, args)
					return ['then', 'catch', 'finally'].includes(String(property)) || !result || typeof result !== 'object' ? result : wrapQuery(result, native)
				}
			},
		})
		const faulty = { transaction: (run: (tx: unknown) => Promise<unknown>) => atomicDb().transaction(tx => run(new Proxy(tx, {
			get(target, property) {
				if (property === 'select') return () => wrapQuery(target.select())
				const value = Reflect.get(target, property)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}))) }
		await expect(f.settle([last], faulty)).rejects.toMatchObject({ _tag: 'OutboxControlError' })
		expect(nativeReads).toBe(6) // Two post-write chunks, not just preflight.
		expect((await atomicRows()).find(row => row.dedupeKey === last)!.status).toBe('pending')
		expect((await atomicVersion()).acknowledgedAt).toBeNull()
	})
	it('fails OFF before touching any database or native settlement port', async () => {
		const ref = { contactId: 'synthetic-atomic-ack' } as ProfileAckReference
		const database = new Proxy({}, { get() { throw new Error('OFF touched database') } })
		const settle = vi.fn(async () => { throw new Error('OFF settled native work') })
		for (const enabled of [undefined, async () => false, async () => { throw new Error('flag unavailable') }])
			expect(await settleAndCompleteProfileAck({ database, ref, settledKeys: [], settle, enabled })).toEqual({ _tag: 'ProfileAckDisabled' })
		expect(settle).not.toHaveBeenCalled()
	})

	it('keeps a live control tombstone out of native due/retry/release/held/metrics/purge queries and writes', async () => {
		const input = profileProofInput()
		const native = outboxEntryForEvent(input.events[0]!, 'bulkDelta')
		const ref: ProfileAckReference = { target: 'production', endpoint: 'events', tenantId: 'org-aihero', contactId: input.contactId, journeyId: 'contact-directory', profileVersion: 3, coordinatorKey: drovrOutboxDedupeKey('production', native), requestId: 'd'.repeat(64), request: { kind: 'delta' } }
		const state = makeAckTombstone(ref, { createdAt: '2026-10-01T00:00:00.000Z', reason: 'incomplete-proof' })
		const key = ackTombstoneKey(ref), id = 'synthetic-ack-control'
		// Fixture seeding only, NOT a production writer or flag enable. The
		// fixed sentinel is required by the existing NOT NULL JSON column.
		await pool.query(`INSERT INTO AI_DrovrOutbox (id, dedupeKey, target, endpoint, tenantId, contactId, journeyId, eventType, idempotencyKey, body, needsFanOut, source, status, attempts, lastError, occurredAt, firstFailedAt, nextAttemptAt, createdAt, heldContinuation) VALUES (?, ?, 'production', 'control', ?, ?, ?, 'profile.ack.tombstone', ?, ?, 0, 'ackTombstone', 'ackTombstone', 0, ?, '2026-10-01 00:00:00', '2026-10-01 00:00:00', '2026-10-01 00:00:00', '2026-10-01 00:00:00', ?)`, [id, key, ref.tenantId, ref.contactId, ref.journeyId, ackTombstoneIdempotencyKey(ref), JSON.stringify(ACK_TOMBSTONE_BODY), 'event-not-live: synthetic operator prose; never a release permission', encodeHeldContinuationEnvelope({ v: 1, profileAck: state })])
		const raw = async () => (await pool.query('SELECT * FROM AI_DrovrOutbox WHERE id = ?', [id]))[0] as unknown as Record<string, unknown>[]
		const before = await raw()
		expect(before).toHaveLength(1)
		expect(before[0]!.needsFanOut).toBe(0)
		expect(readAckTombstone({ ...before[0]!, needsFanOut: before[0]!.needsFanOut === 0 ? false : before[0]!.needsFanOut })).toEqual(state)
		const store = createDrizzleDrovrOutboxStore(live.db)
		// Already due, and also checked AFTER the 400-day boundary: no status
		// filter may rely on the timestamp to hide a control row from dispatch.
		for (const now of ['2026-10-16T00:00:00.000Z', '2028-01-01T00:00:00.000Z']) await expect(store.due({ target: ref.target, now, limit: 100 })).resolves.toEqual([])
		expect(await store.openGates({ target: ref.target, contactIds: [ref.contactId] })).toEqual([])
		expect(await heldBatchRowsLive(ref.target, [key], { requireControl: true })).toEqual([])
		expect(await drovrOutboxWorkStatesLive([{ ...native, endpoint: 'control', idempotencyKey: ackTombstoneIdempotencyKey(ref) } as unknown as DrovrOutboxEntry])).toEqual([])
		expect((await inspectHeldBatchesLive({ key })).entries).toEqual([])
		expect(await store.depth(ref.target)).toEqual(expect.objectContaining({ pending: 0, deferred: 0, held: 0, rejected: 0, oldestPendingFailedAt: null }))
		const held = await heldBatchPersistenceLive()
		expect(await held.read({ target: ref.target, key })).toBeUndefined()
		expect(await held.block({ target: ref.target, key }, 'synthetic prohibited release/hold attempt')).toBe(false)
		expect(await store.leaseQueue!({ target: ref.target, id, dueAt: '2026-10-16T00:00:00.000Z', nextAttemptAt: '2026-10-17T00:00:00.000Z', publicationId: randomUUID() })).toBe(false)
		expect(await store.settlePending!({ target: ref.target, dedupeKeys: [key], at: '2026-10-16T00:00:00.000Z', note: 'synthetic prohibited settlement' })).toBe(0)
		expect(await store.holdPending!({ target: ref.target, dedupeKeys: [key], at: '2026-10-16T00:00:00.000Z', note: 'synthetic prohibited hold', httpStatus: 409 })).toBe(0)
		await store.update(id, { status: 'pending', lastError: 'synthetic prohibited generic release' })
		expect(await store.deleteDeliveredBefore('2026-10-09T00:00:00.000Z', 100)).toBe(0)
		expect(await raw()).toEqual(before)
	})
	it('proves a profile producer only from all retained SQL receiver receipts, independently of operator prose', async () => {
		const input = profileProofInput()
		const entries = input.events.map(event => outboxEntryForEvent(event, 'bulkDelta'))
		await captureDrovrOutboxLive(entries, new Error('synthetic pending capture'))
		expect(await proveContactProfileDeliveryLive(input)).toBe(false)
		// Synthetic receiver outcomes persisted through the actual SQL adapter;
		// no receiver HTTP is issued by this persistence contract test.
		expect(await settleDrovrOutboxLive([entries[0]!], 'synthetic receiver accepted')).toBe(1)
		expect(await proveContactProfileDeliveryLive(input)).toBe(false)
		expect(await settleDrovrOutboxLive([entries[1]!], 'synthetic receiver accepted')).toBe(1)
		for (const prose of [null, 'event-not-live: synthetic lookalike', 'synthetic unrelated prose']) {
			await pool.query('UPDATE AI_DrovrOutbox SET lastError = ?', [prose])
			expect(await proveContactProfileDeliveryLive(input)).toBe(true)
		}
	})
	it('refuses ACK authorization when the additive control column is absent, without a diagnostic fallback', async () => {
		const input = profileProofInput()
		const entries = input.events.map(event => outboxEntryForEvent(event, 'bulkDelta'))
		await captureDrovrOutboxLive(entries, new Error('synthetic capture'))
		expect(await settleDrovrOutboxLive(entries, 'synthetic receiver accepted')).toBe(2)
		await pool.query('ALTER TABLE AI_DrovrOutbox DROP COLUMN heldContinuation')
		try {
			await expect(proveContactProfileDeliveryLive(input)).rejects.toThrow('no coordination, acknowledgement or legacy diagnostic fallback is permitted')
		} finally {
			await pool.query('ALTER TABLE AI_DrovrOutbox ADD COLUMN heldContinuation JSON NULL')
		}
	})

	it('atomically persists an attempt-bound rejected owner stop, ignores prose, and preserves all four control members on later closure', async () => {
		const original = entry('owner:synthetic:unsubscribe', 'contact.unsubscribed')
		await captureDrovrOutboxLive([original], new Error('synthetic original diagnostic'))
		const seed = { v: 1 as const, continuation: { v: 1 as const, blocked: true, reason: 'synthetic coordinator' }, replayProof: { v: 1 as const, handoffs: 7, publicationId: randomUUID() } }
		await pool.query("UPDATE AI_DrovrOutbox SET status = 'rejected', lastStatus = 409, lastError = ?, heldContinuation = ? WHERE idempotencyKey = ?", ['cold-start-never-born: synthetic lookalike', encodeHeldContinuationEnvelope(seed), original.idempotencyKey])
		const store = createDrizzleDrovrOutboxStore(live.db)
		expect(await store.openGates({ target: 'production', contactIds: ['contact-1'] })).toEqual([expect.objectContaining({ status: 'rejected', ownerStopRejectionError: expect.any(String) })])
		const decidedAt = new Date().toISOString()
		expect(await recordOwnerStopRejectionLive({ target: 'production', entry: original, problem: { type: 'urn:drovr:problem:contact-never-born' }, httpStatus: 409, rejectedAttempt: { runId: 'synthetic-sql-sdk-run', requestId: randomUUID(), stepKey: drovrOutboxDedupeKey('production', original), attempt: 0 }, decidedAt })).toBe('rejected')
		for (const prose of ['synthetic unrelated prose', 'event-not-live: synthetic lookalike', 'superseded-unsubscribe:2099-01-01T00:00:00.000Z', null]) {
			await pool.query('UPDATE AI_DrovrOutbox SET lastError = ? WHERE idempotencyKey = ?', [prose, original.idempotencyKey])
			expect(await store.openGates({ target: 'production', contactIds: ['contact-1'] })).toEqual([])
		}
		const [before] = await pool.query('SELECT body, occurredAt, firstFailedAt, lastStatus, lastAttemptAt, deliveredAt FROM AI_DrovrOutbox WHERE idempotencyKey = ?', [original.idempotencyKey])
		await insertLift()
		// The DAO carries the validated closure boundary to its gate caller;
		// it is not an unproved superseded status or a delivery receipt.
		expect(await store.openGates({ target: 'production', contactIds: ['contact-1'] })).toEqual([expect.objectContaining({ status: 'superseded', supersededAt: '2026-09-30T12:01:00.000Z' })])
		const closed = (await rows()).get(original.idempotencyKey)!
		expect(closed.status).toBe('superseded')
		const control = readHeldContinuationEnvelope(closed.heldContinuation)!
		expect(control.continuation).toEqual(seed.continuation)
		expect(control.replayProof).toEqual(seed.replayProof)
		expect(control.ownerStopRejection?.rejectedAttempt.runId).toBe('synthetic-sql-sdk-run')
		expect(control.unsubscribeSupersession?.source.occurredAt).toBe('2026-09-30T12:01:00.000Z')
		const [after] = await pool.query('SELECT body, occurredAt, firstFailedAt, lastStatus, lastAttemptAt, deliveredAt FROM AI_DrovrOutbox WHERE idempotencyKey = ?', [original.idempotencyKey])
		expect(after).toEqual(before)
	})

	it('bounds opaque diagnostic concatenation so it cannot prevent a separately typed held disposition', async () => {
		const original = entry('owner:synthetic:bounded-diagnostic', 'purchase.recorded')
		await captureDrovrOutboxLive([original], new Error('x'.repeat(1000)))
		const receipt = await runDrovrOutboxReplay({ target: 'production', store: createDrizzleDrovrOutboxStore(live.db), now: () => new Date(Date.now() + 1000), post: async () => ({ kind: 'held', detail: 'synthetic operator context '.repeat(100) }), log: { info: () => {}, warn: () => {}, error: () => {} } })
		expect(receipt.held).toBe(1)
		const retained = (await rows()).get(original.idempotencyKey)!
		expect(retained.status).toBe('held')
		expect(retained.lastError).toHaveLength(1000)
	})

	it('retains a historical closed gate when proof is missing or malformed, regardless of lookalike error prose', async () => {
		const original = entry('owner:synthetic:historical', 'contact.unsubscribed')
		await captureDrovrOutboxLive([original], new Error('synthetic diagnostic'))
		const store = createDrizzleDrovrOutboxStore(live.db)
		for (const control of [null, { v: 1, unsubscribeSupersession: { v: 1, source: { table: 'NotContactEvent' } } }]) {
			await pool.query("UPDATE AI_DrovrOutbox SET status = 'superseded', heldContinuation = ?, lastError = ? WHERE idempotencyKey = ?", [control === null ? null : JSON.stringify(control), 'superseded-unsubscribe:2099-01-01T00:00:00.000Z', original.idempotencyKey])
			expect(await store.openGates({ target: 'production', contactIds: ['contact-1'] })).toEqual([expect.objectContaining({ status: 'superseded', unsubscribeSupersessionError: expect.any(String) })])
		}
	})

	it('closes a stale due unsubscribe with its reason before escalation, but posts ties, bounces and complaints', async () => {
		const old = entry('n11:old', 'contact.unsubscribed')
		const tied = entry('n11:tie', 'contact.unsubscribed')
		tied.body = { ...tied.body, occurredAt: '2026-09-30T12:01:00.999Z' }
		tied.occurredAt = '2026-09-30T12:01:00.999Z'
		await captureDrovrOutboxLive([old, tied, entry('n11:bounce', 'contact.bounced'), entry('n11:complaint', 'contact.complained')], undefined)
		await insertLift()
		const store = createDrizzleDrovrOutboxStore(live.db)
		const stale = (await store.due({ target: 'production', now: new Date().toISOString(), limit: 10 })).find(row => row.idempotencyKey === 'n11:old')!
		await store.update(stale.id, { attempts: 999 })
		const post = vi.fn(async () => new Response(null, { status: 202 }))
		const receipt = await runDrovrOutboxReplay({ store, target: 'production', now: () => new Date(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, post: row => postDrovrOutboxRow(row, { ingestUrl: 'https://drovr.example.test/events', apiKeyFor: () => 'synthetic-fixture-key', readBirthOptOuts: async () => [], info: vi.fn(), fanOut: async events => [...events], isNeverBornOwnerStop, deliver: args => deliverDrovrShadowEvent({ ...args, fetcher: post }) }) })
		expect(receipt.supersededUnsubscribes).toBe(1); expect(receipt.delivered).toBe(3)
		expect(post).toHaveBeenCalledTimes(3)
		const found = await rows()
		expect(found.get('n11:old')).toMatchObject({ status: 'superseded', lastError: expect.stringContaining('3mxwwjnmt7iq6') })
		for (const key of ['n11:tie', 'n11:bounce', 'n11:complaint']) expect(found.get(key)?.status).toBe('delivered')
		await pool.query('DELETE FROM AI_ContactEvent')
		expect((await deliverDrovrShadowEvent({ event: old.body as DrovrShadowEvent, config: { ingestUrl: 'https://drovr.example.test/events', apiKey: 'synthetic-fixture-key' }, fetcher: post, clampAt: Date.now() })).status).toBe('superseded')
		expect(post).toHaveBeenCalledTimes(3)
	})

	it('single transport closes a superseded duplicate without rewriting previously delivered history', async () => {
		const old = entry('n11:delivered', 'contact.unsubscribed')
		await captureDrovrOutboxLive([old], undefined)
		await settleDrovrOutboxLive([old], 'accepted before the later lift')
		await insertLift()
		const post = vi.fn(async () => new Response(null, { status: 202 }))
		const answer = await deliverDrovrShadowEvent({ event: old.body as DrovrShadowEvent, config: { ingestUrl: 'https://drovr.example.test/events', apiKey: 'synthetic-fixture-key' }, fetcher: post, clampAt: Date.now() })
		expect(answer.status).toBe('superseded'); expect(post).not.toHaveBeenCalled()
		expect((await rows()).get(old.idempotencyKey)).toMatchObject({ status: 'delivered', lastError: 'accepted before the later lift' })
	})

	it('batch transport closes only superseded unsubscribes and still sends bounce/complaint facts', async () => {
		await insertLift()
		const post = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body))
			expect(body.events.map((event: DrovrShadowEvent) => event.type)).toEqual(['contact.bounced', 'contact.complained'])
			return new Response(JSON.stringify({ accepted: 2, rejected: 0, failed: 0, results: [{ index: 0, status: 'accepted' }, { index: 1, status: 'accepted' }] }), { status: 200 })
		})
		const answer = await deliverBatchOrThrow({ events: ['contact.unsubscribed', 'contact.bounced', 'contact.complained'].map(type => entry(`n11:${type}`, type).body as DrovrShadowEvent), config: { ingestUrl: 'https://drovr.example.test/events', apiKey: 'synthetic-fixture-key' }, fetcher: post, clampAt: Date.now() })
		expect(answer).toEqual({ accepted: 2, rejected: 0, supersededUnsubscribes: 1 })
		expect(post).toHaveBeenCalledOnce()
		const closed = (await rows()).get('n11:contact.unsubscribed')!
		expect(closed.status).toBe('superseded')
		expect(readHeldContinuationEnvelope(closed.heldContinuation)?.unsubscribeSupersession?.source).toEqual({ table: 'AI_ContactEvent', eventType: 'contact.resubscribed', contactId: 'contact-1', occurredAt: '2026-09-30T12:01:00.000Z' })
	})

	it('ownership rereads the first stored body/clock and cannot revive its delivered receipt', async () => {
		const { ownRetryEvents } = await import('./contact-sync-retry-owned-events')
		const firstAt = Date.parse('2032-01-01T00:00:00.000Z')
		const original = entry('synthetic-owned-first', 'contact.unsubscribed').body as DrovrShadowEvent
		const ownedEntry = outboxEntryForEvent(original, 'bulkDelta', { sentAt: firstAt })
		await captureDrovrOutboxLive([ownedEntry], 'synthetic first diagnostic')
		const changed = { ...original, occurredAt: '2032-01-01T00:00:05.000Z' }
		expect(await ownRetryEvents([changed], 'bulkBackfill', firstAt + 5000)).toEqual([{ event: original, clampAt: firstAt, delivered: false, status: 'pending', outboxKey: expect.stringMatching(/^[a-f0-9]{64}$/) }])
		await settleDrovrOutboxLive([ownedEntry], 'synthetic accepted')
		expect(await ownRetryEvents([changed], 'bulkEvergreen', firstAt + 10_000)).toEqual([{ event: original, clampAt: firstAt, delivered: true, status: 'delivered', outboxKey: expect.stringMatching(/^[a-f0-9]{64}$/) }])
		const saved = (await rows()).get(original.idempotencyKey)!
		expect(saved.status).toBe('delivered'); expect(saved.lastError).toBe('synthetic accepted'); expect(saved.firstFailedAt.getTime()).toBe(firstAt)
	})

	it('leases before publish and preserves a fast real consumer recapture instead of overwriting its due time', async () => {
		const item = outboxEntryForEvent({ tenantId: 'org-aihero', contactId: 'synthetic-n4', journeyId: 'contact-directory', type: 'contact.profile.updated', occurredAt: '2026-09-30T12:00:00.000Z', idempotencyKey: 'n4:fast-consumer', payload: { profileVersion: 1, email: 'learner@example.test', firstName: null, holds: [] } }, 'bulkDelta')
		await captureDrovrOutboxLive([item], new Error('synthetic initial HTTP503'))
		const store = createDrizzleDrovrOutboxStore(live.db)
		const at = Date.now()
		const [before] = await store.due({ target: 'production', now: new Date(at).toISOString(), limit: 10 })
		expect(before).toBeDefined()
		const send = vi.fn(async (command: { data: { firstFailedAt?: string } }) => {
			const leased = (await rows()).get('n4:fast-consumer')!
			expect(leased.nextAttemptAt.getTime()).toBe(at + BULK_OUTBOX_QUEUE_WAIT_MS)
			expect(leased.queuePublicationId).toEqual(expect.any(String))
			expect(command.data.firstFailedAt).toBe(before!.firstFailedAt)
			await captureDrovrOutboxLive([{ ...item, firstSentAt: new Date().toISOString() }], new Error('synthetic consumer final HTTP503'))
		})
		const receipt = await runDrovrOutboxReplay({ store, target: 'production', now: () => new Date(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, post: async row => {
			const outcome = await queueCappedReplay(row, send, at, (until, expectedUntil, publicationId) => store.leaseQueue({ target: 'production', id: row.id, nextAttemptAt: until, ...(expectedUntil ? { expectedUntil } : { dueAt: new Date(at).toISOString() }), publicationId }), publicationId => store.abortQueueHandoff({ target: row.target, id: row.id, publicationId }))
			expect(outcome).toBeDefined(); return outcome!
		} })
		expect(receipt).toMatchObject({ queuedHandoffs: 1, failed: 0, circuitOpen: false })
		expect(send).toHaveBeenCalledOnce()
		const after = await store.due({ target: 'production', now: new Date(Date.now() + 1000).toISOString(), limit: 10 })
		expect(after).toHaveLength(1)
		expect(after[0]).toMatchObject({ status: 'pending', attempts: 0, queueHandoffs: 1, firstFailedAt: before!.firstFailedAt, lastError: 'synthetic consumer final HTTP503' })
		expect(after[0]!.body).toEqual(before!.body)
		expect(after[0]!.queuePublicationId).toBeUndefined()
	})

	it('counts successful replay handoffs atomically without touching the lease, diagnostic, target or delivered history', async () => {
		const item = { ...entry('synthetic-handoff-counter', 'contact.profile.updated'), source: 'bulkDelta' as const }
		await captureDrovrOutboxLive([item], 'synthetic original diagnostic')
		const store = createDrizzleDrovrOutboxStore(live.db)
		const [before] = await store.due({ target: 'production', now: new Date(Date.now() + 1000).toISOString(), limit: 10 })
		expect(before).toBeDefined()
		const until = new Date(Date.now() + BULK_OUTBOX_QUEUE_WAIT_MS).toISOString()
		const claim = (publicationId: string) => store.leaseQueue({ target: 'production', id: before!.id, publicationId, nextAttemptAt: until, dueAt: new Date(Date.now() + 1000).toISOString() })
		expect(await claim('synthetic-publication-0')).toBe(true)
		await store.recordQueueHandoff({ target: 'synthetic-other-target', id: before!.id, publicationId: 'synthetic-publication-0', count: true })
		await Promise.all(Array.from({ length: 10 }, () => store.recordQueueHandoff({ target: 'production', id: before!.id, publicationId: 'synthetic-publication-0', count: true })))
		expect((await rows()).get('synthetic-handoff-counter')).toMatchObject({ attempts: 0, queueHandoffs: 1, nextAttemptAt: new Date(until), lastError: before!.lastError })
		// Storage handshake only (no broker calls): distinct claims count,
		// concurrent completion of the same claim counts exactly once.
		for (let index = 1; index < 10; index++) {
			await captureDrovrOutboxLive([item], new Error('synthetic consumer failure'))
			expect(await claim(`synthetic-publication-${index}`)).toBe(true)
			await store.recordQueueHandoff({ target: 'production', id: before!.id, publicationId: `synthetic-publication-${index}`, count: true })
		}
		expect((await rows()).get('synthetic-handoff-counter')).toMatchObject({ attempts: 0, queueHandoffs: 10, nextAttemptAt: new Date(until), lastError: 'synthetic consumer failure', firstFailedAt: new Date(before!.firstFailedAt) })
		// Also exercise the other race order: a later consumer failure must
		// change the diagnostic/release the lease without resetting the proof.
		await captureDrovrOutboxLive([item], new Error('synthetic later consumer HTTP503'))
		expect((await rows()).get('synthetic-handoff-counter')).toMatchObject({ queueHandoffs: 10, attempts: 0, lastError: 'synthetic later consumer HTTP503', firstFailedAt: new Date(before!.firstFailedAt) })
		await settleDrovrOutboxLive([item], 'synthetic accepted')
		await store.recordQueueHandoff({ target: 'production', id: before!.id, publicationId: 'synthetic-publication-9', count: true })
		expect((await rows()).get('synthetic-handoff-counter')).toMatchObject({ attempts: 0, queueHandoffs: 10, status: 'delivered', lastError: 'synthetic accepted' })
	})

	it('a stale abort cannot erase a newer publication claim and an abandoned claim is held without republication', async () => {
		const item = { ...entry('synthetic-abandoned-publication', 'contact.profile.updated'), source: 'bulkDelta' as const }
		await captureDrovrOutboxLive([item], 'synthetic original diagnostic')
		const store = createDrizzleDrovrOutboxStore(live.db); const at = Date.now()
		const [before] = await store.due({ target: 'production', now: new Date(at + 1000).toISOString(), limit: 10 })
		expect(before).toBeDefined()
		const until = new Date(at + BULK_OUTBOX_QUEUE_WAIT_MS).toISOString()
		const claim = (publicationId: string) => store.leaseQueue({ target: 'production', id: before!.id, publicationId, nextAttemptAt: until, dueAt: new Date(Date.now() + 1000).toISOString() })
		expect(await claim('synthetic-old-publication')).toBe(true)
		await store.abortQueueHandoff({ target: 'production', id: before!.id, publicationId: 'synthetic-old-publication' })
		await captureDrovrOutboxLive([item], 'synthetic current consumer diagnostic')
		expect(await claim('synthetic-new-publication')).toBe(true)
		await store.abortQueueHandoff({ target: 'production', id: before!.id, publicationId: 'synthetic-old-publication' })
		await store.recordQueueHandoff({ target: 'production', id: before!.id, publicationId: 'synthetic-old-publication', count: true })
		expect((await rows()).get(item.idempotencyKey)).toMatchObject({ queuePublicationId: 'synthetic-new-publication', lastError: 'synthetic current consumer diagnostic', attempts: 0, queueHandoffs: 0, nextAttemptAt: new Date(until) })
		const after = at + BULK_OUTBOX_QUEUE_WAIT_MS + 1; const send = vi.fn(async () => {})
		const result = await runDrovrOutboxReplay({ store, target: 'production', now: () => new Date(after), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, post: async row => (await queueCappedReplay(row, send, after, (nextAttemptAt, expectedUntil, publicationId) => store.leaseQueue({ target: 'production', id: row.id, publicationId, nextAttemptAt, ...(expectedUntil ? { expectedUntil } : { dueAt: new Date(after).toISOString() }) }), publicationId => store.abortQueueHandoff({ target: 'production', id: row.id, publicationId })))! })
		expect(result).toMatchObject({ held: 1, delivered: 0, failed: 0 }); expect(send).not.toHaveBeenCalled()
		expect((await rows()).get(item.idempotencyKey)).toMatchObject({ status: 'held', attempts: 0, queueHandoffs: 0, firstFailedAt: new Date(before!.firstFailedAt), lastError: expect.stringContaining('QueuePublicationUnknown:') })
	})

	it('CAS queue ownership chooses one publisher and cannot revive delivered history', async () => {
		const item = outboxEntryForEvent({ tenantId: 'org-aihero', contactId: 'synthetic-n4', journeyId: 'contact-directory', type: 'contact.profile.updated', occurredAt: '2026-09-30T12:00:00.000Z', idempotencyKey: 'n4:concurrent', payload: { profileVersion: 1, email: 'learner@example.test', firstName: null, holds: [] } }, 'bulkDelta')
		await captureDrovrOutboxLive([item], new Error('synthetic initial HTTP503'))
		const store = createDrizzleDrovrOutboxStore(live.db)
		const at = Date.now()
		const [before] = await store.due({ target: 'production', now: new Date(at).toISOString(), limit: 10 })
		expect(before).toBeDefined()
		const send = vi.fn(async () => {})
		const lease = (until: string, expectedUntil: string | undefined, publicationId: string) => store.leaseQueue({ target: 'production', id: before!.id, publicationId, nextAttemptAt: until, ...(expectedUntil ? { expectedUntil } : { dueAt: new Date(at).toISOString() }) })
		const outcomes = await Promise.all([queueCappedReplay(before!, send, at, lease, publicationId => store.abortQueueHandoff({ target: 'production', id: before!.id, publicationId })), queueCappedReplay(before!, send, at, lease, publicationId => store.abortQueueHandoff({ target: 'production', id: before!.id, publicationId }))])
		expect(send).toHaveBeenCalledOnce()
		expect(outcomes.map(outcome => outcome?.kind === 'queued' ? outcome.phase : 'invalid').sort()).toEqual(['published', 'stale'])
		await settleDrovrOutboxLive([item], 'synthetic accepted consumer')
		await store.update(before!.id, { status: 'held', lastError: 'stale replay must not overwrite delivery', nextAttemptAt: new Date(at).toISOString() })
		expect((await rows()).get('n4:concurrent')).toMatchObject({ status: 'delivered', lastError: 'synthetic accepted consumer' })
		expect(await lease(new Date(at + 2 * BULK_OUTBOX_QUEUE_WAIT_MS).toISOString(), undefined, 'synthetic-stale-publication')).toBe(false)
	})

	it('releases a pre-captured queue lease on final failure without changing its original birth instant', async () => {
		const queued = { ...entry('queued:1', 'contact.created'), source: 'bulkDelta' as const }
		const windowEnd = new Date(Date.now() + 24 * 60 * 60_000)
		await captureDrovrOutboxLive([queued], undefined, { nextAttemptAt: windowEnd })
		const before = (await rows()).get('queued:1')!
		expect(before.nextAttemptAt.getTime()).toBe(windowEnd.getTime())
		const at = Date.now()
		await captureDrovrOutboxLive([queued], new Error('synthetic final 503'))
		const after = (await rows()).get('queued:1')!
		expect(after.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(at)
		expect(after.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now())
		expect(after.firstFailedAt.getTime()).toBe(before.firstFailedAt.getTime())
		expect(after.lastError).toBe('synthetic final 503')
	})

	it('settles the same immutable key across capture sources and never revives a delivered row', async () => {
		const original = { ...entry('same-key:1', 'contact.created'), source: 'bulkBackfill' as const }
		await captureDrovrOutboxLive([original], undefined, { nextAttemptAt: new Date(Date.now() + 86400000) })
		expect(await settleDrovrOutboxLive([{ ...original, source: 'contactSync' }], 'delivered by straggler')).toBe(1)
		const before = (await rows()).get('same-key:1')!
		await captureDrovrOutboxLive([{ ...original, source: 'bulkDelta' }], new Error('late failed callback'))
		const after = (await rows()).get('same-key:1')!
		expect(after.status).toBe('delivered')
		expect(after.nextAttemptAt.getTime()).toBe(before.nextAttemptAt.getTime())
		expect((await rows()).size).toBe(1)
	})

	it('keeps a stop captured on its first failure pending until the window end it was given', async () => {
		const windowEnd = new Date(Date.now() + 78.75 * 60_000)
		windowEnd.setMilliseconds(0)
		const captured = await captureDrovrOutboxLive(
			[entry('purchase:1', 'purchase.recorded')],
			new Error('drovr answered 503'),
			{ nextAttemptAt: windowEnd },
		)
		expect(captured).toEqual({ status: 'outboxed', count: 1 })
		const stop = (await rows()).get('purchase:1')!
		expect(stop).toMatchObject({ status: 'pending', target: 'production' })
		expect(stop.nextAttemptAt.getTime()).toBe(windowEnd.getTime())
		expect(stop.firstFailedAt.getTime()).toBeLessThan(windowEnd.getTime())
	})

	it('makes a captured row due at once without a window', async () => {
		await captureDrovrOutboxLive(
			[entry('answer:1', 'value-path.answer-selected')],
			new Error('drovr answered 503'),
		)
		const fact = (await rows()).get('answer:1')!
		expect(fact.nextAttemptAt.getTime()).toBe(fact.firstFailedAt.getTime())
	})

	it('settles a stop a retry delivered, pulls its contact held facts to now, and leaves other stops and contacts alone', async () => {
		const windowEnd = new Date(Date.now() + 78.75 * 60_000)
		const stop = entry('purchase:1', 'purchase.recorded')
		await captureDrovrOutboxLive([stop], new Error('503'), {
			nextAttemptAt: windowEnd,
		})
		await captureDrovrOutboxLive(
			[entry('other-stop:1', 'contact.unsubscribed')],
			new Error('503'),
			{ nextAttemptAt: windowEnd },
		)
		// Held behind the stop: the replay moved it to the window end.
		await captureDrovrOutboxLive(
			[
				entry('held:1', 'email.completed'),
				entry('elsewhere:1', 'email.completed', 'contact-2'),
			],
			new Error('synthetic operator note unrelated to stop control'),
			{ waitingForStop: true },
		)
		await pool.query(
			"UPDATE AI_DrovrOutbox SET nextAttemptAt = ? WHERE idempotencyKey IN ('held:1', 'elsewhere:1')",
			[windowEnd],
		)
		const before = Date.now()
		const settled = await settleDrovrOutboxLive(
			[stop],
			'delivered by an Inngest retry',
		)
		expect(settled).toBe(1)
		const after = await rows()
		expect(after.get('purchase:1')).toMatchObject({
			status: 'delivered',
			lastError: 'delivered by an Inngest retry',
		})
		expect(after.get('held:1')!.nextAttemptAt.getTime()).toBeLessThan(
			before + 60_000,
		)
		expect(after.get('other-stop:1')!.nextAttemptAt.getTime()).toBe(
			windowEnd.getTime(),
		)
		expect(after.get('elsewhere:1')!.nextAttemptAt.getTime()).toBe(
			windowEnd.getTime(),
		)
	})

	it('holds a refused stop: an early-captured one moves from pending to held, a new one is written held (row 204c)', async () => {
		const early = entry('purchase:1', 'purchase.recorded')
		await captureDrovrOutboxLive([early], new Error('503'), {
			nextAttemptAt: new Date(Date.now() + 60 * 60_000),
		})
		const captured = await holdDrovrStopsLive(
			[early, entry('unsubscribe:1', 'contact.unsubscribed')],
			'drovr refused the stop (404): unknown-route',
			404,
		)
		expect(captured).toEqual({ status: 'outboxed', count: 2 })
		const after = await rows()
		expect(after.get('purchase:1')).toMatchObject({
			status: 'held',
			lastError: 'drovr refused the stop (404): unknown-route',
		})
		expect(after.get('unsubscribe:1')).toMatchObject({
			status: 'held',
			target: 'production',
		})
		// A later settle (a retry that did land) never reopens a held stop.
		expect(await settleDrovrOutboxLive([early], 'delivered')).toBe(0)
		expect((await rows()).get('purchase:1')?.status).toBe('held')
	})

	it('settles only this deployment target', async () => {
		const stop = entry('purchase:1', 'purchase.recorded')
		vi.stubEnv('VERCEL_ENV', 'preview')
		vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'worker/x')
		await captureDrovrOutboxLive([stop], new Error('503'), {
			nextAttemptAt: new Date(Date.now() + 60 * 60_000),
		})
		vi.stubEnv('VERCEL_ENV', 'production')
		expect(await settleDrovrOutboxLive([stop], 'delivered')).toBe(0)
		expect((await rows()).get('purchase:1')).toMatchObject({
			status: 'pending',
			target: 'preview:worker/x',
		})
	})
})
