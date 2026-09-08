import fs from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { Auth } from '@auth/core'
import Postmark from '@auth/core/providers/postmark'
import {
	createOAuthContainmentAdapter,
	runWithOAuthContainmentRequest,
} from '@/server/oauth-link-containment'
import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import {
	contact,
	contactEvent,
	providerIdentity,
	users,
	sessions,
} from '@/db/schema'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import { createEmailTokenLoginObservationWriter } from './email-token-login-observation-mysql'
import { sessionTokenHash } from './verified-owner-evidence'
import {
	createVerifiedEmailObservation,
	type EmailLoginCapture,
} from '@/server/verified-email-observation'
// Match the app's adapter generic; the runtime is the actual mysql2 database.
const actualAdapter = (database: MySqlDatabase<any, any, any>) =>
	DrizzleAdapter<MySqlDatabase<any, any, any>>(database, mysqlTable)
const schema = {
	...journeySchema,
	contact,
	contactEvent,
	providerIdentity,
	users,
	sessions,
}
const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
const at = '2026-09-08T04:30:00.123Z',
	later = '2026-09-08T04:31:00.789Z',
	secret = 'synthetic-HMAC-secret'
integration('email login observation real adapter and disposable MySQL', () => {
	let server: Pool | undefined,
		pool: Pool,
		readPool: Pool,
		name: string | undefined,
		uri: string
	let database: MySql2Database<typeof schema>,
		readback: MySql2Database<typeof schema>,
		capture: EmailLoginCapture
	let now: string
	const statements: string[] = []
	function makeDatabase(client: Pool) {
		preserveQueryResultShape(client)
		const acquire = client.getConnection.bind(client)
		client.getConnection = async () => {
			return preserveQueryResultShape(await acquire())
		}
		return drizzle(client, {
			schema,
			mode: 'planetscale',
			logger: { logQuery: (query) => statements.push(query) },
		})
	}
	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_email_observation_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		uri = target.toString()
		pool = mysql.createPool({
			uri,
			timezone: 'Z',
			multipleStatements: true,
			connectionLimit: 5,
		})
		readPool = mysql.createPool({ uri, timezone: 'Z', connectionLimit: 3 })
		for (const migration of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260714_ai_hero_optin_attribution.sql',
			'20260717_ai_hero_side_effect_intent_completed_at.sql',
		])
			await pool.query(
				await fs.readFile(
					new URL(`../../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		// Exact pinned CourseBuilder User fsp3 and Session (second-precision expiry).
		await pool.query(
			'CREATE TABLE AI_User (id varchar(255) PRIMARY KEY, name varchar(255), role varchar(191) NOT NULL DEFAULT "user", email varchar(255) NOT NULL UNIQUE, fields json, emailVerified timestamp(3) NULL, image varchar(255), createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3))',
		)
		await pool.query(
			'CREATE TABLE AI_Session (sessionToken varchar(255) PRIMARY KEY, userId varchar(255) NOT NULL, expires timestamp NOT NULL, INDEX userId_idx(userId))',
		)
		await pool.query(
			'CREATE TABLE AI_VerificationToken (identifier varchar(255) NOT NULL, token varchar(255) NOT NULL, expires timestamp NOT NULL, createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(identifier,token))',
		)
		database = makeDatabase(pool)
		readback = makeDatabase(readPool)
	})
	afterAll(async () => {
		await pool?.end()
		await readPool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})
	beforeEach(async () => {
		await pool.query('DELETE FROM AI_VerificationToken')
		for (const table of [
			contactEvent,
			providerIdentity,
			contact,
			sessions,
			users,
		])
			await database.delete(table)
		now = at
		await database
			.insert(contact)
			.values({ id: 'contact', email: 'learner@example.test' })
		await database.insert(providerIdentity).values({
			id: 'kit',
			contactId: 'contact',
			provider: 'kit',
			externalId: '12345',
			evidence: {},
		})
		await database
			.insert(users)
			.values({ id: 'user', email: 'learner@example.test' })
		// Actual installed adapter, not a fake echo of requested writes.
		const adapter = actualAdapter(database)
		const user = await adapter.updateUser!({
			id: 'user',
			emailVerified: new Date(at),
		})
		const session = await adapter.createSession!({
			userId: 'user',
			sessionToken: 'synthetic-session',
			expires: new Date('2026-09-09T00:00:00.789Z'),
		})
		expect(user.emailVerified!.toISOString()).toBe(at)
		expect(session.expires.getUTCMilliseconds()).toBe(0)
		const [storedSession] = await database
			.select()
			.from(sessions)
			.where(eq(sessions.sessionToken, session.sessionToken))
		expect(session.expires).toEqual(storedSession!.expires)
		capture = {
			userId: user.id,
			email: user.email!,
			verifiedAt: user.emailVerified!.toISOString(),
			acceptedToken: 'actual-returned-stored-token-reference',
			sessionToken: session.sessionToken,
			sessionExpires: session.expires.toISOString(),
		}
		statements.length = 0
	})
	const writer = (db = database, read = readback) =>
		createEmailTokenLoginObservationWriter({
			database: db,
			readbackDatabase: read,
			secret,
			now: () => new Date(now),
		})
	it('actual SDK callback plus contained real adapter commits observation for the session in the response cookie', async () => {
		const adapter = actualAdapter(database),
			authSecret = 'synthetic-Auth-secret',
			rawToken = 'synthetic-callback-token'
		await adapter.createVerificationToken!({
			identifier: capture.email,
			token: createHash('sha256')
				.update(rawToken + authSecret)
				.digest('hex'),
			expires: new Date(Date.now() + 60000),
		})
		const observed: EmailLoginCapture[] = [],
			outcomes: string[] = [],
			order: string[] = []
		const persist = createEmailTokenLoginObservationWriter({
			database,
			readbackDatabase: readback,
			secret,
			now: () => new Date(),
		})
		const observer = createVerifiedEmailObservation({
			enabled: true,
			providerId: 'postmark',
			now: () => new Date(),
			writer: async (input) => {
				order.push('observe')
				observed.push(input)
				const result = await persist(input)
				outcomes.push(result.type)
				return result
			},
		})
		const request = new Request(
			`https://auth.example.test/api/auth/callback/postmark?email=${capture.email}&token=${rawToken}`,
			{ method: 'POST' },
		)
		const response = await observer.run(request, () =>
			runWithOAuthContainmentRequest(request, () =>
				Auth(request, {
					adapter: observer.wrapAdapter(createOAuthContainmentAdapter(adapter)),
					secret: authSecret,
					trustHost: true,
					basePath: '/api/auth',
					providers: [
						Postmark({
							apiKey: 'synthetic',
							from: 'fixture@example.test',
							sendVerificationRequest: async () => {
								throw new Error('No provider calls allowed')
							},
						}),
					],
					events: {
						signIn: observer.wrapSignIn(async () => {
							order.push('prior-signIn')
						}),
					},
					logger: { error: () => {}, warn: () => {}, debug: () => {} },
				}),
			),
		)
		expect(response.status).toBe(302)
		expect(order).toEqual(['prior-signIn', 'observe'])
		expect(outcomes).toEqual(['Recorded'])
		expect(observed).toHaveLength(1)
		expect(response.headers.get('set-cookie')).toContain(
			observed[0]!.sessionToken,
		)
		const [saved] = await readback.select().from(contactEvent)
		expect(saved!.payloadSummary).toMatchObject({
			verifiedAt: observed[0]!.verifiedAt,
			sessionTokenHash: sessionTokenHash(secret, observed[0]!.sessionToken),
		})
	})
	it('records canonical first event from actual fsp3 User/session returns with COMMIT and independent readback', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		// Drizzle 0.36 executes begin/commit SQL through its logger, not the
		// mysql2 beginTransaction()/commit() convenience methods.
		expect(statements.map((s) => s.trim().toLowerCase())).toContain('begin')
		expect(statements.map((s) => s.trim().toLowerCase())).toContain('commit')
		expect(
			statements.some((s) =>
				/set transaction isolation level serializable/i.test(s),
			),
		).toBe(true)
		expect(
			statements.filter((s) => /^update|^delete|^replace/i.test(s)),
		).toEqual([])
		const rows = await readback.select().from(contactEvent)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.payloadSummary).toMatchObject({
			verifiedAt: at,
			observedAt: at,
			sessionTokenHash: sessionTokenHash(secret, capture.sessionToken),
		})
		for (const raw of [
			capture.email,
			capture.acceptedToken,
			capture.sessionToken,
		])
			expect(JSON.stringify(rows)).not.toContain(raw)
		expect(rows[0]!.occurredAt.toISOString()).toBe('2026-09-08T04:30:00.000Z')
	})
	it('same capture replay preserves original row and observedAt', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		const before = await readback.select().from(contactEvent)
		now = later
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		expect(await readback.select().from(contactEvent)).toEqual(before)
	})
	it('same token/new created session conflicts without borrowing first session', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		const before = await readback.select().from(contactEvent)
		const session = await actualAdapter(database).createSession!({
			userId: 'user',
			sessionToken: 'second-session',
			expires: new Date(capture.sessionExpires),
		})
		expect(
			await writer()({ ...capture, sessionToken: session.sessionToken }),
		).toMatchObject({ type: 'Conflict', reason: 'ConflictingReplay' })
		expect(await readback.select().from(contactEvent)).toEqual(before)
	})
	it('same token/new verification revision conflicts without overwriting', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		const before = await readback.select().from(contactEvent)
		now = later
		const user = await actualAdapter(database).updateUser!({
			id: 'user',
			emailVerified: new Date(later),
		})
		expect(
			await writer()({
				...capture,
				verifiedAt: user.emailVerified!.toISOString(),
			}),
		).toMatchObject({ type: 'Conflict' })
		expect(await readback.select().from(contactEvent)).toEqual(before)
	})
	it.each(['missing', 'expired', 'foreign'] as const)(
		'holds %s session',
		async (mode) => {
			if (mode === 'missing') await database.delete(sessions)
			else
				await database
					.update(sessions)
					.set(
						mode === 'foreign'
							? { userId: 'foreign-user' }
							: { expires: new Date('2026-09-01T00:00:00Z') },
					)
			expect(await writer()(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'SessionUnavailable',
			})
			expect(await readback.select().from(contactEvent)).toEqual([])
		},
	)
	it.each(['duplicate-case', 'duplicate-space'] as const)(
		'normalized %s is ambiguity, not a second first-match identity',
		async (mode) => {
			await database
				.insert(contact)
				.values({
					id: 'normalized-duplicate',
					email:
						mode === 'duplicate-case'
							? capture.email.toUpperCase()
							: ` ${capture.email} `,
				})
			expect(await writer()(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'ContactUnavailable',
			})
			expect(await readback.select().from(contactEvent)).toEqual([])
		},
	)
	it.each(['missing', 'duplicate', 'email-change'] as const)(
		'holds %s Contact candidate',
		async (mode) => {
			if (mode === 'missing') await database.delete(contact)
			if (mode === 'duplicate')
				await database
					.insert(contact)
					.values({ id: 'duplicate', email: capture.email })
			if (mode === 'email-change')
				await database.update(contact).set({ email: 'other@example.test' })
			expect(await writer()(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'ContactUnavailable',
			})
			expect(await readback.select().from(contactEvent)).toEqual([])
		},
	)
	it.each(['missing', 'duplicate', 'foreign'] as const)(
		'holds %s Kit provenance',
		async (mode) => {
			if (mode === 'missing') await database.delete(providerIdentity)
			if (mode === 'duplicate')
				await database.insert(providerIdentity).values({
					id: 'kit2',
					contactId: 'contact',
					provider: 'kit',
					externalId: '23456',
					evidence: {},
				})
			if (mode === 'foreign')
				await database.update(providerIdentity).set({ contactId: 'elsewhere' })
			expect(await writer()(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'IdentityUnavailable',
			})
		},
	)
	it.each(['email', 'revision'] as const)(
		'fresh locked User rejects changed %s',
		async (mode) => {
			await database
				.update(users)
				.set(
					mode === 'email'
						? { email: 'changed@example.test' }
						: { emailVerified: new Date(later) },
				)
			expect(await writer()(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'VerificationChanged',
			})
		},
	)
	it('current sliding session expiry may differ from the captured createSession return', async () => {
		await database
			.update(sessions)
			.set({ expires: new Date('2026-09-10T00:00:00Z') })
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
	})
	it('a prior saved event cannot substitute for a deleted current session', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		const before = await readback.select().from(contactEvent)
		await database.delete(sessions)
		expect(await writer()(capture)).toMatchObject({
			type: 'Unavailable',
			reason: 'SessionUnavailable',
		})
		expect(await readback.select().from(contactEvent)).toEqual(before)
	})
	it('changed Kit external identity cannot borrow the old full envelope', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		const before = await readback.select().from(contactEvent)
		await database
			.update(providerIdentity)
			.set({ externalId: 'different-identity' })
		expect(await writer()(capture)).toMatchObject({ type: 'Conflict' })
		expect(await readback.select().from(contactEvent)).toEqual(before)
	})
	it('rollback before COMMIT and absent readback is not proof of persistence', async () => {
		const db = new Proxy(database, {
			get(target, key) {
				if (key === 'transaction')
					return (
						callback: Parameters<typeof database.transaction>[0],
						config: Parameters<typeof database.transaction>[1],
					) =>
						target.transaction(async (tx) => {
							await callback(tx)
							throw new Error('synthetic failure before COMMIT')
						}, config)
				const value = Reflect.get(target, key)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
		expect(await writer(db)(capture)).toMatchObject({
			type: 'Unavailable',
			reason: 'ReadbackUnavailable',
		})
		expect(statements.map((s) => s.trim().toLowerCase())).toContain('rollback')
		expect(statements.map((s) => s.trim().toLowerCase())).not.toContain(
			'commit',
		)
		expect(await readback.select().from(contactEvent)).toEqual([])
	})
	it('an unsupported version probe holds before transaction even with real InnoDB tables', async () => {
		let calls = 0
		const db = new Proxy(database, {
			get(target, key) {
				if (key === 'execute')
					return (...args: Parameters<typeof database.execute>) =>
						++calls === 1
							? Promise.resolve([[{ version: '8.0.30-Vitess' }], []])
							: target.execute(...args)
				const value = Reflect.get(target, key)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
		expect(await writer(db)(capture)).toMatchObject({
			type: 'Unavailable',
			reason: 'SerializationUnavailable',
		})
		expect(statements.map((s) => s.trim().toLowerCase())).not.toContain('begin')
		expect(await readback.select().from(contactEvent)).toEqual([])
	})
	function transactionProxy(after: (result: unknown) => Promise<void>) {
		return new Proxy(database, {
			get(target, key) {
				if (key === 'transaction')
					return async (
						callback: Parameters<typeof database.transaction>[0],
						config: Parameters<typeof database.transaction>[1],
					) => {
						const result = await target.transaction(callback, config)
						await after(result)
						return result
					}
				const value = Reflect.get(target, key)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
	}
	it('unknown COMMIT acknowledgement counts only with exact independent saved row', async () => {
		const db = transactionProxy(async () => {
			throw new Error('synthetic lost COMMIT acknowledgement')
		})
		expect(await writer(db)(capture)).toEqual({ type: 'Recorded' })
		expect(await readback.select().from(contactEvent)).toHaveLength(1)
	})
	it('unknown COMMIT and failed readback remains unavailable although row exists', async () => {
		const db = transactionProxy(async () => {
			throw new Error('synthetic lost COMMIT acknowledgement')
		})
		const failingRead = new Proxy(readback, {
			get(target, key) {
				if (key === 'select')
					return () => {
						throw new Error('synthetic read unavailable')
					}
				return Reflect.get(target, key)
			},
		})
		expect(await writer(db, failingRead)(capture)).toMatchObject({
			type: 'Unavailable',
		})
		expect(await readback.select().from(contactEvent)).toHaveLength(1)
	})
	it('independent new pools/writer recover original immutable event without request memory', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		const before = await readback.select().from(contactEvent),
			freshPool = mysql.createPool({ uri, timezone: 'Z' }),
			freshRead = mysql.createPool({ uri, timezone: 'Z' })
		try {
			now = later
			expect(
				await writer(
					makeDatabase(freshPool),
					makeDatabase(freshRead),
				)(structuredClone(capture)),
			).toEqual({ type: 'Recorded' })
			expect(await readback.select().from(contactEvent)).toEqual(before)
		} finally {
			await freshPool.end()
			await freshRead.end()
		}
	})
	it.each(['envelope', 'payload'] as const)(
		'full readback rejects tampered %s',
		async (mode) => {
			expect(await writer()(capture)).toEqual({ type: 'Recorded' })
			if (mode === 'envelope')
				await database
					.update(contactEvent)
					.set({ providerReference: 'tampered' })
			else
				await database
					.update(contactEvent)
					.set({ payloadSummary: { not: 'a canonical observation' } })
			expect(await writer()(capture)).toMatchObject({ type: 'Conflict' })
		},
	)
	it.each(['duplicate-contact', 'user-revision', 'user-email'] as const)(
		'serializable selection blocks concurrent %s until COMMIT (native InnoDB only)',
		async (mode) => {
			let entered!: () => void, release!: () => void
			const locked = new Promise<void>((resolve) => {
					entered = resolve
				}),
				gate = new Promise<void>((resolve) => {
					release = resolve
				})
			const db = new Proxy(database, {
				get(target, key) {
					if (key === 'transaction')
						return (
							callback: Parameters<typeof database.transaction>[0],
							config: Parameters<typeof database.transaction>[1],
						) =>
							target.transaction(async (tx) => {
								const result = await callback(tx)
								entered()
								await gate
								return result
							}, config)
					const value = Reflect.get(target, key)
					return typeof value === 'function' ? value.bind(target) : value
				},
			})
			const writing = writer(db)(capture)
			// Race against completion too: setup/validation failure must not hang fixture.
			await Promise.race([
				locked,
				writing.then(() => {
					throw new Error('Writer did not reach held transaction')
				}),
			])
			const competing = await readPool.getConnection()
			try {
				await competing.query('SET SESSION innodb_lock_wait_timeout=1')
				const query =
					mode === 'duplicate-contact'
						? "INSERT INTO AI_Contact (id,email) VALUES ('racer','learner@example.test')"
						: mode === 'user-email'
							? "UPDATE AI_User SET email='changed@example.test' WHERE id='user'"
							: "UPDATE AI_User SET emailVerified='2026-09-08 04:31:00.789' WHERE id='user'"
				await expect(competing.query(query)).rejects.toMatchObject({
					errno: 1205,
				})
				release()
				expect(await writing).toEqual({ type: 'Recorded' })
				// The lock protects one point, NOT all future uniqueness/identity changes.
				await competing.query(query)
				expect(await writer()(capture)).toMatchObject({
					type: 'Unavailable',
					reason:
						mode === 'duplicate-contact'
							? 'ContactUnavailable'
							: 'VerificationChanged',
				})
				expect(await readback.select().from(contactEvent)).toHaveLength(1)
			} finally {
				release()
				await writing
				competing.release()
			}
		},
		15000,
	)
})
