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
import { eq, sql } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import mysql, { type Pool } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import {
	createEmailTokenLoginObservationWriter,
	emailObservationInputSchema,
} from './email-token-login-observation-mysql'
import { sessionTokenHash, emailFingerprint } from './verified-owner-evidence'
import {
	createVerifiedEmailObservation,
	type EmailLoginCapture,
} from '@/server/verified-email-observation'
// Match the app's adapter generic; the runtime is the actual mysql2 database.
const actualAdapter = (database: MySqlDatabase<any, any, any>) =>
	DrizzleAdapter<MySqlDatabase<any, any, any>>(database, mysqlTable)
import {
	createOwnedEmailObservationTransactions,
	createMySqlEmailObservationLeaseSource,
	type EmailObservationLease,
	type EmailObservationTransactions,
} from './email-observation-transaction'
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
	function ownedTransactions(
		client = pool,
		decorate: (lease: EmailObservationLease) => EmailObservationLease = (
			lease,
		) => lease,
	) {
		const source = createMySqlEmailObservationLeaseSource({
			pool: client,
			logger: { logQuery: (query) => statements.push(query) },
		})
		return createOwnedEmailObservationTransactions({
			async acquire() {
				const lease = await source.acquire()
				try {
					return decorate(lease)
				} catch (error) {
					lease.destroy()
					throw error
				}
			},
		})
	}
	const writer = (
		db = database,
		read = readback,
		transactions = ownedTransactions(),
	) =>
		createEmailTokenLoginObservationWriter({
			database: db,
			transactions,
			readbackDatabase: read,
			secret,
			now: () => new Date(now),
		})
	it.each([
		'none',
		'set',
		'begin',
		'validation',
		'rollback-failure',
		'commit-ack-loss',
	] as const)(
		'actual SDK/adapter preserves auth with owned connection mode=%s',
		async (mode) => {
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
			const disposed: string[] = []
			if (mode === 'validation' || mode === 'rollback-failure')
				await database
					.insert(contact)
					.values({ id: 'sdk-duplicate', email: capture.email })
			const transactions = ownedTransactions(pool, (lease) => ({
				...lease,
				async setSerializable() {
					await lease.setSerializable()
					if (mode === 'set')
						throw new Error('synthetic SET acknowledgement loss')
				},
				async begin() {
					await lease.begin()
					if (mode === 'begin')
						throw new Error('synthetic BEGIN acknowledgement loss')
				},
				async commit() {
					await lease.commit()
					if (mode === 'commit-ack-loss')
						throw new Error('synthetic COMMIT acknowledgement loss')
				},
				async rollback() {
					if (mode === 'rollback-failure')
						throw new Error('synthetic rollback unavailable')
					await lease.rollback()
				},
				release() {
					disposed.push('release')
					lease.release()
				},
				destroy() {
					disposed.push('destroy')
					lease.destroy()
				},
			}))
			const persist = createEmailTokenLoginObservationWriter({
				database,
				transactions,
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
						adapter: observer.wrapAdapter(
							createOAuthContainmentAdapter(adapter),
						),
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
			const recorded = mode === 'none' || mode === 'commit-ack-loss'
			expect(outcomes).toEqual([recorded ? 'Recorded' : 'Unavailable'])
			expect(disposed).toEqual([
				mode === 'none' || mode === 'validation' ? 'release' : 'destroy',
			])
			expect(observed).toHaveLength(1)
			expect(response.headers.get('set-cookie')).toContain(
				observed[0]!.sessionToken,
			)
			const saved = await readback.select().from(contactEvent)
			if (recorded) {
				expect(saved).toHaveLength(1)
				expect(saved[0]!.payloadSummary).toMatchObject({
					verifiedAt: observed[0]!.verifiedAt,
					sessionTokenHash: sessionTokenHash(secret, observed[0]!.sessionToken),
				})
			} else expect(saved).toEqual([])
		},
	)
	it('records canonical first event from actual fsp3 User/session returns with COMMIT and independent readback', async () => {
		expect(await writer()(capture)).toEqual({ type: 'Recorded' })
		// Owned connection logs its native control calls; Drizzle logs DML.
		// No pooled Drizzle transaction is used.
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
	it.each([
		'duplicate-case',
		'duplicate-space',
		'duplicate-tab',
		'duplicate-bom',
	] as const)(
		'normalized %s is ambiguity, not a second first-match identity',
		async (mode) => {
			await database.insert(contact).values({
				id: 'normalized-duplicate',
				email:
					mode === 'duplicate-case'
						? capture.email.toUpperCase()
						: mode === 'duplicate-space'
							? ` ${capture.email} `
							: mode === 'duplicate-tab'
								? `\t${capture.email}\n`
								: `\uFEFF${capture.email}\u00A0`,
			})
			expect(await writer()(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'ContactUnavailable',
			})
			expect(await readback.select().from(contactEvent)).toEqual([])
		},
	)
	it.each([
		{ label: 'greek-final-sigma', raw: 'ΟΣ@example.test' },
		{ label: 'capital-dotted-I', raw: 'İ@example.test' },
		{ label: 'kelvin-sign', raw: 'K@example.test' },
	])('native SQL versus JS normalization: $label', async ({ label, raw }) => {
		const normalized = raw.trim().toLowerCase()
		// The accepted fingerprint codec permits these and gives the raw/JS
		// normalized forms the same identity. Do not change that codec.
		expect(emailFingerprint(secret, raw)).toBe(
			emailFingerprint(secret, normalized),
		)
		await database.update(contact).set({ email: normalized })
		await database
			.insert(contact)
			.values({ id: 'unicode-duplicate', email: raw })
		await actualAdapter(database).updateUser!({
			id: 'user',
			email: normalized,
			emailVerified: new Date(at),
		})
		const [probe] = await database
			.select({ normalized: sql<string>`lower(${raw})` })
			.from(contact)
			.limit(1)
		const sqlCandidates = await database
			.select({ id: contact.id })
			.from(contact)
			.where(sql`lower(${contact.email}) = ${normalized}`)
			.limit(2)
		const input = { ...capture, email: normalized },
			admitted = emailObservationInputSchema.safeParse(input).success
		console.info(
			'email-normalization-probe',
			JSON.stringify({
				label,
				sqlLowerMatchesJs: probe!.normalized === normalized,
				sqlCandidates: sqlCandidates.length,
				producerAdmits: admitted,
			}),
		)
		expect(await database.select().from(contact)).toHaveLength(2)
		// Unsupported normalized email syntax holds before SQL; an admitted
		// form MUST detect both candidates, even if SQL excluded the raw one.
		expect(await writer()(input)).toMatchObject({
			type: 'Unavailable',
			reason: admitted ? 'ContactUnavailable' : 'InvalidCapture',
		})
		expect(await readback.select().from(contactEvent)).toEqual([])
	})
	it.each(
		['utf8mb4_bin', 'utf8mb4_0900_ai_ci'].flatMap((collation) =>
			[
				'nbsp',
				'ideographic-space',
				'vertical-tab',
				'kelvin',
				'turkish-superset',
			].map((kind) => ({ collation, kind })),
		),
	)(
		'normalized candidate hold with $collation / $kind',
		async ({ collation, kind }) => {
			// Isolated fixture DDL only. Keep original binary cases; this adds the
			// alternate declared-schema profile, not production concurrency proof.
			await pool.query(
				`ALTER TABLE AI_Contact MODIFY email varchar(255) CHARACTER SET utf8mb4 COLLATE ${collation} NULL`,
			)
			try {
				const ascii =
					kind === 'turkish-superset'
						? 'i@example.test'
						: kind === 'kelvin'
							? 'k@example.test'
							: capture.email
				const raw =
					kind === 'nbsp'
						? `\u00A0${ascii}\u00A0`
						: kind === 'ideographic-space'
							? `\u3000${ascii}\u3000`
							: kind === 'vertical-tab'
								? `\u000B${ascii}\u000B`
								: kind === 'kelvin'
									? 'K@example.test'
									: 'İ@example.test'
				await database.update(contact).set({ email: ascii })
				await database
					.insert(contact)
					.values({ id: 'profile-duplicate', email: raw })
				await actualAdapter(database).updateUser!({
					id: 'user',
					email: ascii,
					emailVerified: new Date(at),
				})
				const input = { ...capture, email: ascii }
				expect(emailObservationInputSchema.safeParse(input).success).toBe(true)
				if (kind === 'vertical-tab') {
					expect(raw.trim().toLowerCase()).toBe(ascii)
					const stored = await database
						.select({ email: contact.email })
						.from(contact)
					expect(stored).toHaveLength(2)
					expect(stored).toEqual(
						expect.arrayContaining([{ email: ascii }, { email: raw }]),
					)
					// Exercise the unchanged production predicate, not a proposed fix.
					const normalized = sql<string>`lower(regexp_replace(${contact.email}, ${'^[\\s\\x{FEFF}]+|[\\s\\x{FEFF}]+$'}, ''))`
					const candidates = await database
						.select({ email: contact.email, normalized })
						.from(contact)
						.where(sql`${normalized} = ${ascii}`)
					expect(candidates).toHaveLength(2)
					expect(candidates.map((row) => row.normalized)).toEqual([
						ascii,
						ascii,
					])
				}
				if (kind === 'turkish-superset') {
					expect(raw.trim().toLowerCase()).not.toBe(ascii)
					expect(emailFingerprint(secret, raw)).not.toBe(
						emailFingerprint(secret, ascii),
					)
					const candidates = await database
						.select({ id: contact.id })
						.from(contact)
						.where(sql`lower(${contact.email}) = ${ascii}`)
					expect(candidates).toHaveLength(2)
				}
				expect(await writer()(input)).toMatchObject({
					type: 'Unavailable',
					reason: 'ContactUnavailable',
				})
				expect(await readback.select().from(contactEvent)).toEqual([])
			} finally {
				await pool.query(
					'ALTER TABLE AI_Contact MODIFY email varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL',
				)
			}
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
		const owned = ownedTransactions()
		const transactions: EmailObservationTransactions = {
			run: (operation) =>
				owned.run(async (db) => {
					await operation(db)
					throw new Error('synthetic failure before COMMIT')
				}),
		}
		expect(
			await writer(database, readback, transactions)(capture),
		).toMatchObject({
			type: 'Unavailable',
			reason: 'ReadbackUnavailable',
		})
		expect(statements.map((s) => s.trim().toLowerCase())).toContain('rollback')
		expect(statements.map((s) => s.trim().toLowerCase())).not.toContain(
			'commit',
		)
		expect(await readback.select().from(contactEvent)).toEqual([])
	})
	it.each(['8.0.30-Vitess', '8.0.23-PlanetScale', '8.0.46-unverified-proxy'])(
		'unsupported version %s holds before transaction with real InnoDB tables',
		async (version) => {
			let calls = 0
			const db = new Proxy(database, {
				get(target, key) {
					if (key === 'execute')
						return (...args: Parameters<typeof database.execute>) =>
							++calls === 1
								? Promise.resolve([[{ version }], []])
								: target.execute(...args)
					const value = Reflect.get(target, key)
					return typeof value === 'function' ? value.bind(target) : value
				},
			})
			expect(await writer(db)(capture)).toMatchObject({
				type: 'Unavailable',
				reason: 'SerializationUnavailable',
			})
			expect(statements.map((s) => s.trim().toLowerCase())).not.toContain(
				'begin',
			)
			expect(await readback.select().from(contactEvent)).toEqual([])
		},
	)
	it.each([
		'set',
		'begin',
		'callback',
		'rollback',
		'rollback-ack',
		'commit',
	] as const)(
		'owned lease %s failure disposes once and does not deplete a size-one pool',
		async (fault) => {
			const limited = mysql.createPool({
				uri,
				timezone: 'Z',
				connectionLimit: 1,
				waitForConnections: false,
				connectTimeout: 1000,
			})
			try {
				for (let attempt = 0; attempt < 3; attempt++) {
					const marker = `lease_probe_${fault}_${attempt}`,
						failure = new Error(`synthetic ${fault}`),
						validation = new Error('original validation'),
						disposed: string[] = []
					const transactions = ownedTransactions(limited, (lease) => ({
						...lease,
						async setSerializable() {
							await lease.setSerializable()
							if (fault === 'set') throw failure
						},
						async begin() {
							await lease.begin()
							if (fault === 'begin') {
								await lease.database
									.insert(users)
									.values({ id: marker, email: `${marker}@example.test` })
								throw failure
							}
						},
						async commit() {
							await lease.commit()
							if (fault === 'commit') throw failure
						},
						async rollback() {
							if (fault === 'rollback') throw failure
							await lease.rollback()
							if (fault === 'rollback-ack') throw failure
						},
						release() {
							disposed.push('release')
							lease.release()
						},
						destroy() {
							disposed.push('destroy')
							lease.destroy()
						},
					}))
					await expect(
						transactions.run(async (db) => {
							await db
								.insert(users)
								.values({ id: marker, email: `${marker}@example.test` })
							if (
								fault === 'callback' ||
								fault === 'rollback' ||
								fault === 'rollback-ack'
							)
								throw validation
						}),
					).rejects.toBe(
						fault === 'callback' ||
							fault === 'rollback' ||
							fault === 'rollback-ack'
							? validation
							: failure,
					)
					expect(disposed).toEqual([
						fault === 'callback' ? 'release' : 'destroy',
					])
					// No queue: a leaked lease fails immediately instead of hanging.
					const next = await limited.getConnection()
					try {
						await next.query({
							sql: 'SET SESSION innodb_lock_wait_timeout=1',
							timeout: 1000,
						})
						const rows = await database
							.select({ id: users.id })
							.from(users)
							.where(eq(users.id, marker))
						expect(rows).toHaveLength(fault === 'commit' ? 1 : 0)
						// Reusing the rolled-back key also proves the abandoned write lock
						// is gone, not just that a fresh connection can SELECT 1.
						if (fault !== 'commit')
							await next.query(
								{
									sql: 'INSERT INTO AI_User (id,email) VALUES (?,?)',
									timeout: 2000,
								},
								[marker, `${marker}@example.test`],
							)
						await next.query(
							{ sql: 'DELETE FROM AI_User WHERE id=?', timeout: 2000 },
							[marker],
						)
						next.release()
					} catch (error) {
						next.destroy()
						throw error
					}
				}
				expect(
					statements.filter((s) =>
						/^(?:update|delete|replace)\s+`?AI_ContactEvent`?/i.test(s),
					),
				).toEqual([])
			} finally {
				await limited.end()
			}
		},
		15000,
	)
	it('pending COMMIT keeps exclusive ownership until acknowledgment; late success is read back', async () => {
		const limited = mysql.createPool({
			uri,
			timezone: 'Z',
			connectionLimit: 1,
			waitForConnections: false,
			connectTimeout: 1000,
		})
		let entered!: () => void, finish!: () => void
		const committing = new Promise<void>((resolve) => {
				entered = resolve
			}),
			gate = new Promise<void>((resolve) => {
				finish = resolve
			}),
			disposed: string[] = []
		const transactions = ownedTransactions(limited, (lease) => ({
			...lease,
			async commit() {
				entered()
				await gate
				await lease.commit()
			},
			release() {
				disposed.push('release')
				lease.release()
			},
			destroy() {
				disposed.push('destroy')
				lease.destroy()
			},
		}))
		const writing = writer(database, readback, transactions)(capture)
		try {
			await Promise.race([
				committing,
				writing.then(() => {
					throw new Error('COMMIT phase not reached')
				}),
			])
			expect(disposed).toEqual([])
			await expect(limited.getConnection()).rejects.toThrow(
				'No connections available',
			)
			finish()
			expect(await writing).toEqual({ type: 'Recorded' })
			expect(disposed).toEqual(['release'])
			expect(await readback.select().from(contactEvent)).toHaveLength(1)
			const next = await limited.getConnection()
			next.release()
		} finally {
			finish()
			await writing
			await limited.end()
		}
	})
	function commitAcknowledgementLoss() {
		return ownedTransactions(pool, (lease) => ({
			...lease,
			async commit() {
				await lease.commit()
				throw new Error('synthetic lost COMMIT acknowledgement')
			},
		}))
	}
	it('unknown COMMIT acknowledgement counts only with exact independent saved row', async () => {
		const transactions = commitAcknowledgementLoss()
		expect(await writer(database, readback, transactions)(capture)).toEqual({
			type: 'Recorded',
		})
		expect(await readback.select().from(contactEvent)).toHaveLength(1)
	})
	it('unknown COMMIT and failed readback remains unavailable although row exists', async () => {
		const transactions = commitAcknowledgementLoss()
		const failingRead = new Proxy(readback, {
			get(target, key) {
				if (key === 'select')
					return () => {
						throw new Error('synthetic read unavailable')
					}
				return Reflect.get(target, key)
			},
		})
		expect(
			await writer(database, failingRead, transactions)(capture),
		).toMatchObject({
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
					ownedTransactions(freshPool),
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
			const owned = ownedTransactions()
			const transactions: EmailObservationTransactions = {
				run: (operation) =>
					owned.run(async (db) => {
						const result = await operation(db)
						entered()
						await gate
						return result
					}),
			}
			const writing = writer(database, readback, transactions)(capture)
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
