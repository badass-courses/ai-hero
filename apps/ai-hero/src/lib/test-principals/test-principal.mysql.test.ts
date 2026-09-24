import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Auth } from '@auth/core'
import Postmark from '@auth/core/providers/postmark'
import { eq } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

import { contact, sessions, users, verificationTokens } from '@/db/schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { contactEmailWriteValues } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { personalizeDrovrIntent } from '@/lib/subscriber-marketing/drovr-personalize'
import { DROVR_SKILLS_COURSE_JOURNEY_ID } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import { authorizeExclusiveCouponSelection } from '@/lib/exclusive-coupon-authorization'
import {
	createCouponAuthority,
	readCouponEvidence,
} from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority'
import {
	couponCommerceSchema,
	createMySqlCouponCommerceStore,
} from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql'
import { validateMySqlIntegrationServerUrl } from '@/lib/team-purchase-mysql-test-guard'
import { createAuthJsAdapter } from '@/server/auth-js-adapter'
import {
	createMagicLinkConfirmHandler,
	createMagicLinkGetHandler,
	MAGIC_LINK_COOKIE_NAME,
} from '@/server/magic-link-confirmation'
import {
	createOAuthContainmentAdapter,
	runWithOAuthContainmentRequest,
} from '@/server/oauth-link-containment'

import {
	hashVerificationToken,
	newSignInToken,
	testPrincipalIdentity,
	testPrincipalSignIn,
} from './test-principal'
import { issueTestPrincipalCoupon } from './test-principal-coupon'
import {
	deleteTestPrincipalRecords,
	expiredTestPrincipalIds,
	mintTestPrincipalRecords,
	testPrincipalCouponId,
} from './test-principal-store'

const merchantEvidence = {
	id: 'mysql-merchant',
	identifier: 'mysql-provider',
	merchantAccountId: 'mysql-account',
	currency: 'USD',
	amountOffCents: 10000,
	type: 'special',
	sourceReference: 'disposable-fixture-readback',
}

// Real @auth/core 0.37.2 email callback, real ai-hero magic-link confirmation
// handlers, real CourseBuilder Drizzle adapter, disposable MySQL. Nothing
// here reimplements how Auth.js checks the minted token.
const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)
const authSecret = 'synthetic-auth-secret-for-mysql-test'
const cookieSecret = 'synthetic-magic-link-cookie-secret'
const origin = 'https://www.aihero.dev'

integration('test principals on disposable MySQL with real Auth.js', () => {
	let server: Pool | undefined
	let pool: Pool
	let name: string | undefined
	let database: MySqlDatabase<any, any, any>
	let createdUsers: string[]

	beforeAll(async () => {
		if (!serverUrl || process.env.CI !== 'true')
			throw new Error('Explicit disposable CI server required')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_test_principal_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const target = new URL(safe)
		target.pathname = `/${name}`
		pool = preserveQueryResultShape(
			mysql.createPool({
				uri: target.toString(),
				timezone: 'Z',
				multipleStatements: true,
				connectionLimit: 5,
			}),
		)
		const acquire = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(await acquire())) as typeof pool.getConnection
		for (const migration of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260714_ai_hero_optin_attribution.sql',
			'20260717_ai_hero_side_effect_intent_completed_at.sql',
			'plans/20260908_contact_email_equivalence.sql',
			// The capture repository reads SideEffectIntent's course-run columns.
			'20260831_ai_hero_email_course_evergreen_schema.sql',
			'20260907_evergreen_admission_attempts.sql',
		])
			await pool.query(
				await fs.readFile(
					new URL(`../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		// Pinned CourseBuilder User, Session and VerificationToken shapes.
		await pool.query(
			'CREATE TABLE AI_User (id varchar(255) PRIMARY KEY, name varchar(255), role varchar(191) NOT NULL DEFAULT "user", email varchar(255) NOT NULL UNIQUE, fields json, emailVerified timestamp(3) NULL, image varchar(255), createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3))',
		)
		await pool.query(
			'CREATE TABLE AI_Session (sessionToken varchar(255) PRIMARY KEY, userId varchar(255) NOT NULL, expires timestamp NOT NULL, INDEX userId_idx(userId))',
		)
		await pool.query(
			'CREATE TABLE AI_VerificationToken (identifier varchar(255) NOT NULL, token varchar(255) NOT NULL, expires timestamp NOT NULL, createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(identifier,token))',
		)
		// Pinned commerce shapes, as the coupon-authority MySQL suite uses.
		for (const ddl of [
			'CREATE TABLE AI_MerchantCoupon (id varchar(191) NOT NULL PRIMARY KEY, identifier varchar(191) UNIQUE, organizationId varchar(191), status int NOT NULL DEFAULT 0, merchantAccountId varchar(191) NOT NULL, percentageDiscount decimal(3,2), amountDiscount int, type varchar(191))',
			'CREATE TABLE AI_Coupon (id varchar(191) NOT NULL PRIMARY KEY, organizationId varchar(191), code varchar(191) UNIQUE, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires timestamp(3) NULL, fields json, maxUses int NOT NULL DEFAULT -1, `default` boolean NOT NULL DEFAULT false, merchantCouponId varchar(191), status int NOT NULL DEFAULT 0, usedCount int NOT NULL DEFAULT 0, percentageDiscount decimal(3,2), amountDiscount int, restrictedToProductId varchar(191), INDEX Coupon_id_code_index(id,code))',
			'CREATE TABLE AI_EntitlementType (id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL UNIQUE, description text)',
			'CREATE TABLE AI_Entitlement (id varchar(191) NOT NULL PRIMARY KEY, entitlementType varchar(255) NOT NULL, userId varchar(191), organizationId varchar(191), organizationMembershipId varchar(191), sourceType varchar(255) NOT NULL, sourceId varchar(191) NOT NULL, metadata json, expiresAt timestamp(3) NULL, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL, INDEX source_idx(sourceType,sourceId))',
		])
			await pool.query(ddl)
		database = drizzle(pool, { mode: 'planetscale' })
	})

	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})

	beforeEach(async () => {
		createdUsers = []
		for (const table of ['AI_VerificationToken', 'AI_Session', 'AI_User', 'AI_Contact', 'AI_ContactState'])
			await pool.query(`DELETE FROM ${table}`)
		for (const table of ['AI_Coupon', 'AI_Entitlement', 'AI_EntitlementType', 'AI_MerchantCoupon'])
			await pool.query(`DELETE FROM ${table}`)
		await pool.query(
			"INSERT INTO AI_MerchantCoupon (id, identifier, merchantAccountId, amountDiscount, status, type) VALUES ('mysql-merchant', 'mysql-provider', 'mysql-account', 10000, 1, 'special')",
		)
		await pool.query(
			"INSERT INTO AI_EntitlementType (id, name) VALUES ('mysql-credit-type', 'apply_special_credit')",
		)
		// A real learner, whose rows must survive every synthetic operation.
		await database.insert(users).values({ id: 'user-real', email: 'real@example.test' })
		await database.insert(contact).values({
			id: 'contact-real',
			userId: 'user-real',
			...contactEmailWriteValues('real@example.test'),
		})
		await database.insert(sessions).values({
			sessionToken: 'session-real',
			userId: 'user-real',
			expires: new Date(Date.now() + 86_400_000),
		})
	})

	const authHandler = (request: Request) =>
		runWithOAuthContainmentRequest(request, () =>
			Auth(request, {
				adapter: createOAuthContainmentAdapter(
					createAuthJsAdapter(DrizzleAdapter(database, mysqlTable)),
				),
				secret: authSecret,
				trustHost: true,
				basePath: '/api/auth',
				providers: [
					Postmark({
						apiKey: 'synthetic',
						from: 'fixture@example.test',
						sendVerificationRequest: async () => {
							throw new Error('A test principal is never emailed')
						},
					}),
				],
				events: {
					createUser: async ({ user }) => {
						createdUsers.push(String(user.id))
					},
				},
				logger: { error: () => {}, warn: () => {}, debug: () => {} },
			}),
		) as Promise<Response>

	const mint = async (runId: string, now = new Date()) => {
		const rawToken = newSignInToken()
		const tokenExpires = new Date(now.getTime() + 5 * 60_000)
		const records = await mintTestPrincipalRecords(database, {
			runId,
			now,
			tokenHash: hashVerificationToken(rawToken, authSecret),
			tokenExpires,
		})
		return { records, rawToken, tokenExpires }
	}

	const realRows = async () => {
		const [[row]] = (await pool.query(
			"SELECT (SELECT COUNT(*) FROM AI_User WHERE id = 'user-real') AS users, (SELECT COUNT(*) FROM AI_Contact WHERE id = 'contact-real') AS contacts, (SELECT COUNT(*) FROM AI_Session WHERE userId = 'user-real') AS sessions",
		)) as unknown as [[{ users: number; contacts: number; sessions: number }]]
		return row
	}

	it('signs in through the real magic-link confirmation and Auth.js email callback', async () => {
		const { records, rawToken, tokenExpires } = await mint('run-signin-0001')
		expect(records.status).toBe('minted')
		if (records.status === 'limit') return
		const signIn = testPrincipalSignIn({
			origin,
			email: records.identity.email,
			rawToken,
			expiresAt: tokenExpires,
		})

		// Step 1: the emailed-link GET parks the token in a sealed cookie.
		const getHandler = createMagicLinkGetHandler(authHandler, { secret: cookieSecret })
		const parked = await getHandler(new Request(signIn.url))
		expect(parked.status).toBe(307)
		expect(new URL(parked.headers.get('location')!).pathname).toBe('/login/verify')
		const confirmationCookie = parked.headers
			.get('set-cookie')!
			.split(';')[0]!
		expect(confirmationCookie.startsWith(`${MAGIC_LINK_COOKIE_NAME}=`)).toBe(true)
		// The GET alone signs nobody in.
		expect(
			await database.select().from(sessions).where(eq(sessions.userId, records.identity.principalId)),
		).toEqual([])

		// Step 2: the Confirm POST replays it through the real callback.
		const confirmHandler = createMagicLinkConfirmHandler(
			authHandler as (request: NextRequest) => Promise<Response>,
			{ secret: cookieSecret },
		)
		const signedIn = await confirmHandler(
			new Request(new URL(signIn.confirm.path, origin), {
				method: 'POST',
				headers: { cookie: confirmationCookie },
			}),
		)
		expect(signedIn.status).toBe(302)
		const principalSessions = await database
			.select()
			.from(sessions)
			.where(eq(sessions.userId, records.identity.principalId))
		expect(principalSessions).toHaveLength(1)
		expect(signedIn.headers.get('set-cookie')).toContain(
			principalSessions[0]!.sessionToken,
		)
		expect(createdUsers).toEqual([])
		// One-time: the token is spent.
		expect(
			await database
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.identifier, records.identity.email)),
		).toEqual([])
		const replay = await confirmHandler(
			new Request(new URL(signIn.confirm.path, origin), {
				method: 'POST',
				headers: { cookie: confirmationCookie },
			}),
		)
		// Auth.js answers a spent token with a redirect to its error page.
		expect(replay.headers.get('location')).toMatch(/error=Verification/)
		expect(replay.headers.get('set-cookie') ?? '').not.toContain('authjs.session-token=')
		expect(
			await database.select().from(sessions).where(eq(sessions.userId, records.identity.principalId)),
		).toHaveLength(1)
		expect(await realRows()).toEqual({ users: 1, contacts: 1, sessions: 1 })
	})

	it('gives personalize a real state, so a minted principal gets signed links', async () => {
		const { records } = await mint('run-personalize-01')
		if (records.status === 'limit') throw new Error('unexpected limit')
		const answer = await personalizeDrovrIntent({
			repository: new DrizzleCaptureMarketingRepository(database as never),
			request: {
				tenantId: 'org-aihero',
				contactId: records.identity.contactId,
				journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
				emailKey: 'ai-hero-skills-workflow.email-0',
				idempotencyKey: 'test-principal:run-personalize-01:email-0',
				dueAt: records.createdAt.toISOString(),
			},
			answerPages: [
				{
					id: 'answer-1',
					type: 'value-path-page',
					fields: {
						kind: 'answer',
						slug: 'what-next',
						sequenceId: 'ai-hero-skills-workflow',
						emailId: 'email-0',
						position: 1,
					},
				} as never,
			],
			pathTokenSecret: 'synthetic-path-token-secret',
			baseUrl: origin,
		})
		expect(answer?.reasons).toEqual([])
		expect(Object.keys(answer?.variables ?? {}).length).toBeGreaterThan(0)
		expect(JSON.stringify(answer?.variables)).toContain('pt=')
		await deleteTestPrincipalRecords(database, records.identity.principalId)
	})

	it('answers concurrent mints for one runId with one principal and no error', async () => {
		const results = await Promise.all(
			[1, 2, 3].map(() => mint('run-concurrent-01')),
		)
		const statuses = results.map(({ records }) => records.status).sort()
		expect(statuses).toEqual(['existing', 'existing', 'minted'])
		const [[rows]] = (await pool.query(
			"SELECT COUNT(*) AS n FROM AI_User WHERE id LIKE 'synthetic\\_%'",
		)) as unknown as [[{ n: number }]]
		expect(rows.n).toBe(1)
		await deleteTestPrincipalRecords(
			database,
			testPrincipalIdentity('run-concurrent-01').principalId,
		)
	})

	it('holds the cap under concurrent mints for different runIds', async () => {
		const results = await Promise.all(
			[1, 2, 3, 4, 5, 6, 7].map((i) => mint(`run-capcheck-0${i}`)),
		)
		const minted = results.filter(({ records }) => records.status === 'minted')
		const limited = results.filter(({ records }) => records.status === 'limit')
		expect(minted).toHaveLength(5)
		expect(limited).toHaveLength(2)
		const [[rows]] = (await pool.query(
			"SELECT COUNT(*) AS n FROM AI_User WHERE id LIKE 'synthetic\\_%'",
		)) as unknown as [[{ n: number }]]
		expect(rows.n).toBe(5)
		for (const { records } of minted)
			if (records.status !== 'limit')
				await deleteTestPrincipalRecords(database, records.identity.principalId)
	})

	it('lets the reaper skip a principal re-minted after it was listed', async () => {
		const start = new Date()
		const { records } = await mint('run-reaper-race1', start)
		if (records.status === 'limit') throw new Error('unexpected limit')
		const later = new Date(start.getTime() + 2 * 3_600_000)
		const cutoff = new Date(later.getTime() - 3_600_000)
		expect(await expiredTestPrincipalIds(database, { now: later, limit: 50 })).toEqual([
			records.identity.principalId,
		])
		// The run starts again before the reaper gets to it.
		expect((await mint('run-reaper-race1', later)).records.status).toBe('minted')
		expect(
			await deleteTestPrincipalRecords(database, records.identity.principalId, {
				createdBefore: cutoff,
			}),
		).toBeNull()
		const [[rows]] = (await pool.query(
			'SELECT COUNT(*) AS n FROM AI_User WHERE id = ?',
			[records.identity.principalId],
		)) as unknown as [[{ n: number }]]
		expect(rows.n).toBe(1)
		await deleteTestPrincipalRecords(database, records.identity.principalId)
	})

	it('issues a canonical one-use crash-course coupon for the run and deletes only it', async () => {
		const commerce = drizzle(pool, { schema: couponCommerceSchema, mode: 'default' })
		const authority = (clock: Date) =>
			createCouponAuthority({
				store: createMySqlCouponCommerceStore(commerce),
				merchantCouponEvidence: merchantEvidence,
				now: () => clock.toISOString(),
			})
		const start = new Date()
		// A real contact's evergreen coupon, issued the same way, must survive.
		const real = await issueTestPrincipalCoupon({
			authority: authority(new Date(start.getTime() + 60_000)),
			identity: { principalId: 'user-real', contactId: 'contact-real', email: 'real@example.test' },
			principalCreatedAt: start,
			origin,
		})
		expect(real.status).toBe('issued')

		const { records } = await mint('run-coupon-0001', start)
		if (records.status === 'limit') throw new Error('unexpected limit')
		const clock = new Date(records.createdAt.getTime() + 60_000)
		const issued = await issueTestPrincipalCoupon({
			authority: authority(clock),
			identity: records.identity,
			principalCreatedAt: records.createdAt,
			origin,
		})
		if (issued.status !== 'issued') throw new Error(issued.reason)
		expect(issued.coupon.couponId).toBe(testPrincipalCouponId(records.identity))
		expect(issued.coupon.expiresAt).toBe(records.expiresAt.toISOString())
		expect(new URL(issued.coupon.offerUrl).searchParams.get('coupon')).toBe(
			issued.coupon.couponId,
		)

		// A repeated mint replays the same issue: same coupon, one row.
		const replay = await issueTestPrincipalCoupon({
			authority: authority(new Date(clock.getTime() + 60_000)),
			identity: records.identity,
			principalCreatedAt: records.createdAt,
			origin,
		})
		expect(replay).toEqual(issued)

		const [row] = await commerce
			.select()
			.from(couponCommerceSchema.coupon)
			.where(eq(couponCommerceSchema.coupon.id, issued.coupon.couponId))
		expect(row).toMatchObject({ maxUses: 1, usedCount: 0, status: 1 })
		// The real evidence check and the shareable checkout gate accept it
		// for any signed-in buyer at quantity one, inside its hour.
		expect(readCouponEvidence(row as never).coupon.terms.productId).toBe('product-ma254')
		const gate = await authorizeExclusiveCouponSelection({
			adapter: {
				getCoupon: async () => row as never,
				getMerchantCoupon: async () =>
					({ id: 'mysql-merchant', type: 'special', status: 1, amountDiscount: 10000 }) as never,
				getEntitlementTypeByName: async () => ({ id: 'mysql-credit-type' }),
				getEntitlementsForUser: async () => [],
			},
			verifiedUserId: 'any-buyer',
			productId: 'product-ma254',
			quantity: 1,
			requestedSiteCouponId: issued.coupon.couponId,
			requestedMerchantCouponId: 'mysql-merchant',
			now: clock,
		})
		expect(gate.authorized).toBe(true)

		const deleted = await deleteTestPrincipalRecords(database, records.identity.principalId)
		expect(deleted?.removed).toMatchObject({ AI_Coupon: 1 })
		const [[coupons]] = (await pool.query(
			'SELECT COUNT(*) AS n FROM AI_Coupon WHERE id = ?',
			[issued.coupon.couponId],
		)) as unknown as [[{ n: number }]]
		expect(coupons.n).toBe(0)
		const [[realCoupons]] = (await pool.query(
			'SELECT COUNT(*) AS n FROM AI_Coupon WHERE id = ?',
			[real.status === 'issued' ? real.coupon.couponId : ''],
		)) as unknown as [[{ n: number }]]
		expect(realCoupons.n).toBe(1)
		expect(await realRows()).toEqual({ users: 1, contacts: 1, sessions: 1 })
	})

	it('is idempotent per runId and deletes only the synthetic principal', async () => {
		const first = await mint('run-delete-0001')
		const again = await mint('run-delete-0001')
		expect(first.records.status).toBe('minted')
		expect(again.records.status).toBe('existing')
		if (again.records.status === 'limit') return
		const { principalId } = again.records.identity
		await database.insert(sessions).values({
			sessionToken: 'session-synthetic',
			userId: principalId,
			expires: new Date(Date.now() + 86_400_000),
		})

		const deleted = await deleteTestPrincipalRecords(database, principalId)
		expect(deleted?.removed).toMatchObject({
			AI_User: 1,
			AI_Contact: 1,
			AI_Session: 1,
			AI_VerificationToken: 1,
		})
		expect(await realRows()).toEqual({ users: 1, contacts: 1, sessions: 1 })
		const [[left]] = (await pool.query(
			"SELECT COUNT(*) AS n FROM AI_User WHERE id LIKE 'synthetic\\_%'",
		)) as unknown as [[{ n: number }]]
		expect(left.n).toBe(0)
		// Idempotent: nothing left to delete.
		expect(await deleteTestPrincipalRecords(database, principalId)).toBeNull()
	})

	it('never deletes a real user even when handed its id', async () => {
		expect(await deleteTestPrincipalRecords(database, 'user-real')).toBeNull()
		// A synthetic-looking id whose row is not a minted principal is refused too.
		await database.insert(users).values({ id: 'synthetic_forged', email: 'forged@example.test' })
		expect(await deleteTestPrincipalRecords(database, 'synthetic_forged')).toBeNull()
		expect(await realRows()).toEqual({ users: 1, contacts: 1, sessions: 1 })
		await pool.query("DELETE FROM AI_User WHERE id = 'synthetic_forged'")
	})

	it('holds at most five live principals and restarts an expired runId', async () => {
		const now = new Date()
		for (let i = 1; i <= 5; i += 1) {
			expect((await mint(`run-limit-000${i}`, now)).records.status).toBe('minted')
		}
		expect((await mint('run-limit-0006', now)).records).toEqual({ status: 'limit', live: 5 })

		// Two hours on, all five are past their hour: the reaper sees them, and
		// the same runId mints afresh instead of extending the old principal.
		const later = new Date(now.getTime() + 2 * 3_600_000)
		expect((await expiredTestPrincipalIds(database, { now: later, limit: 50 })).sort()).toEqual(
			[1, 2, 3, 4, 5].map((i) => testPrincipalIdentity(`run-limit-000${i}`).principalId).sort(),
		)
		const restarted = await mint('run-limit-0001', later)
		expect(restarted.records.status).toBe('minted')
		if (restarted.records.status === 'limit') return
		expect(restarted.records.createdAt.toISOString()).toBe(later.toISOString())
		for (const id of await expiredTestPrincipalIds(database, { now: later, limit: 50 }))
			await deleteTestPrincipalRecords(database, id)
		const [[left]] = (await pool.query(
			"SELECT COUNT(*) AS n FROM AI_User WHERE id LIKE 'synthetic\\_%'",
		)) as unknown as [[{ n: number }]]
		expect(left.n).toBe(1)
		expect(await realRows()).toEqual({ users: 1, contacts: 1, sessions: 1 })
		await deleteTestPrincipalRecords(database, restarted.records.identity.principalId)
	})
})
