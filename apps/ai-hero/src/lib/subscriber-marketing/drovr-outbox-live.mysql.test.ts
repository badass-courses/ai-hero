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
import { outboxEntryForEvent, type DrovrOutboxEntry } from './drovr-outbox'

// The live wrappers against the real store: only the database handle and
// the logger are stood in, so their option plumbing is what is tested.
const live = vi.hoisted(() => ({ db: undefined as unknown }))
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
	settleDrovrOutboxLive,
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

type Stored = {
	idempotencyKey: string
	status: string
	nextAttemptAt: Date
	firstFailedAt: Date
	lastError: string | null
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
		live.db = drizzle(pool, { schema: databaseSchema, mode: 'default' })
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		vi.stubEnv('VERCEL_ENV', 'production')
		await pool.query('DELETE FROM AI_DrovrOutbox')
	})

	const rows = async () => {
		const [found] = (await pool.query(
			'SELECT idempotencyKey, status, nextAttemptAt, firstFailedAt, lastError, target FROM AI_DrovrOutbox ORDER BY idempotencyKey',
		)) as unknown as [Stored[]]
		return new Map(found.map((row) => [row.idempotencyKey, row]))
	}

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
			new Error('held behind a stop the outbox still owes'),
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
