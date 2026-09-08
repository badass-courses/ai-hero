import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { contact, contactEvent, providerIdentity, users } from '@/db/schema'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { createDrizzleJourneyLedger } from './drizzle-ledger'
import { createCouponAuthority } from './coupon-authority'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import {
	createMySqlVerifiedOwnerEvidenceReadStore,
	createVerifiedOwnerProofReader,
	VerifiedOwnerProofUnavailable,
} from './verified-owner-proof'
import {
	ownerProofFixture,
	canonicalOriginProbes,
	corruptCanonicalOrigin,
} from './verified-owner-proof.fixtures'
import {
	couponCommerceSchema,
	createMySqlCouponCommerceStore,
} from './coupon-authority-mysql'
import {
	emailTokenLoginEventRow,
	resolveOwnerContact,
	sessionTokenHash,
} from './verified-owner-evidence'

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL
const integration = describe.skipIf(!serverUrl)

function corruptionCommit(
	commit: typeof journeySchema.evergreenOfferJourneyCommit.$inferSelect,
) {
	// Drizzle bypasses the JSON encoder for JS null. Explicit SQL expression
	// stores JSON null in the NOT NULL JSON column without weakening its schema.
	return {
		...commit,
		snapshot:
			commit.snapshot === null ? sql`cast(${'null'} as json)` : commit.snapshot,
	}
}

// Compilation only: drizzle.mock creates no connection and executes no SQL.
// Retain the SQL-NULL control separately from the representable JSON-null probe.
describe('owner proof corruption SQL encoding', () => {
	const database = drizzle.mock({ schema: journeySchema, mode: 'planetscale' })
	it('plain JS null is a SQL NULL bind parameter, not encoded JSON', () => {
		const query = database
			.update(journeySchema.evergreenOfferJourneyCommit)
			.set({ snapshot: null })
			.toSQL()
		expect(query.params).toEqual([null])
	})
	it('encodes the null-snapshot corruption as JSON null, never SQL NULL', () => {
		const f = ownerProofFixture()
		corruptCanonicalOrigin(f, 'null-snapshot')
		const query = database
			.update(journeySchema.evergreenOfferJourneyCommit)
			.set(corruptionCommit(f.commit))
			.toSQL()
		expect(query.sql).toContain('cast(? as json)')
		expect(query.params).toContain('null')
		// admissionContactId is legitimately SQL NULL; only snapshot must be JSON.
		const snapshotOnly = database
			.update(journeySchema.evergreenOfferJourneyCommit)
			.set({ snapshot: corruptionCommit(f.commit).snapshot })
			.toSQL()
		expect(snapshotOnly.params).toEqual(['null'])
	})
})
const schema = {
	...journeySchema,
	contact,
	contactEvent,
	providerIdentity,
	users,
}
integration('owner proof disposable MySQL', () => {
	let server: Pool | undefined
	let pool: Pool
	let database: MySql2Database<typeof schema>
	let name: string | undefined
	let f: ReturnType<typeof ownerProofFixture>
	const statements: string[] = []
	beforeAll(async () => {
		if (!serverUrl) throw new Error('Missing disposable server')
		const safe = validateMySqlIntegrationServerUrl(serverUrl, {
			nodeEnv: process.env.NODE_ENV,
			vercelEnv: process.env.VERCEL_ENV,
		})
		server = mysql.createPool({ uri: safe.toString(), timezone: 'Z' })
		name = `aih_owner_proof_test_${randomUUID().replaceAll('-', '')}`
		await server.query(
			`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		)
		const uri = new URL(safe)
		uri.pathname = `/${name}`
		pool = mysql.createPool({
			uri: uri.toString(),
			timezone: 'Z',
			multipleStatements: true,
			connectionLimit: 5,
		})
		for (const migration of [
			'20260504_ai_hero_subscriber_marketing_gate_a.sql',
			'20260714_ai_hero_optin_attribution.sql',
			'20260717_ai_hero_side_effect_intent_completed_at.sql',
			'plans/20260908_contact_email_equivalence.sql',
			'20260831_ai_hero_email_course_evergreen_schema.sql',
			'20260907_evergreen_admission_attempts.sql',
		])
			await pool.query(
				await fs.readFile(
					new URL(`../../../db/migrations/${migration}`, import.meta.url),
					'utf8',
				),
			)
		await pool.query(
			'CREATE TABLE AI_User (id varchar(255) PRIMARY KEY, name varchar(255), role varchar(191) NOT NULL DEFAULT "user", email varchar(255) NOT NULL UNIQUE, fields json, emailVerified timestamp(3) NULL, image varchar(255), createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3))',
		)
		// Existing commerce schema subset, disposable fixtures only.
		for (const ddl of [
			'CREATE TABLE AI_MerchantCoupon (id varchar(191) NOT NULL PRIMARY KEY, identifier varchar(191) UNIQUE, organizationId varchar(191), status int NOT NULL DEFAULT 0, merchantAccountId varchar(191) NOT NULL, percentageDiscount decimal(3,2), amountDiscount int, type varchar(191))',
			'CREATE TABLE AI_Coupon (id varchar(191) NOT NULL PRIMARY KEY, organizationId varchar(191), code varchar(191) UNIQUE, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), expires timestamp(3) NULL, fields json, maxUses int NOT NULL DEFAULT -1, `default` boolean NOT NULL DEFAULT false, merchantCouponId varchar(191), status int NOT NULL DEFAULT 0, usedCount int NOT NULL DEFAULT 0, percentageDiscount decimal(3,2), amountDiscount int, restrictedToProductId varchar(191))',
			'CREATE TABLE AI_EntitlementType (id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL UNIQUE, description text)',
			'CREATE TABLE AI_Entitlement (id varchar(191) NOT NULL PRIMARY KEY, entitlementType varchar(255) NOT NULL, userId varchar(191), organizationId varchar(191), organizationMembershipId varchar(191), sourceType varchar(255) NOT NULL, sourceId varchar(191) NOT NULL, metadata json, expiresAt timestamp(3) NULL, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL, INDEX source_idx(sourceType,sourceId))',
		])
			await pool.query(ddl)
		database = drizzle(preserveQueryResultShape(pool), {
			schema,
			mode: 'planetscale',
			logger: {
				logQuery: (query) => {
					statements.push(query)
				},
			},
		})
	})
	afterAll(async () => {
		await pool?.end()
		if (server && name) await server.query(`DROP DATABASE \`${name}\``)
		await server?.end()
	})
	beforeEach(async () => {
		for (const table of [
			'AI_Entitlement',
			'AI_Coupon',
			'AI_MerchantCoupon',
			'AI_EntitlementType',
			'AI_EvergreenOfferJourneyWake',
			'AI_EvergreenOfferJourneyIntent',
			'AI_EvergreenOfferJourneyCommit',
			'AI_ContactEvent',
			'AI_ProviderIdentity',
			'AI_Contact',
			'AI_User',
		])
			await pool.query(`DELETE FROM \`${table}\``)
		f = ownerProofFixture()
		await database
			.insert(contact)
			.values({ id: f.input.contactId, email: f.input.lockedContact.email })
		await database.insert(users).values({
			id: f.input.verifiedUserId,
			email: f.input.lockedUser.email,
			emailVerified: new Date(f.login.verifiedAt),
		})
		await database.insert(providerIdentity).values(f.identity)
		await database.insert(contactEvent).values(f.rows)
		const ledger = createDrizzleJourneyLedger(database)
		for (const candidate of f.candidates) {
			const committed = await Effect.runPromise(ledger.commit(candidate))
			expect(committed.committed).toBe(true)
		}
		statements.length = 0
	})
	const reader = () =>
		createVerifiedOwnerProofReader({
			store: createMySqlVerifiedOwnerEvidenceReadStore(database),
			secret: f.secret,
			now: () => f.now,
		})
	it('uses canonical history SELECTs, no live identity/ContactLink query and no writes', async () => {
		expect(await reader()(f.input)).toMatchObject({
			sourceReference: 'contact-event:proof-claim-event',
		})
		expect(statements).toHaveLength(8)
		for (const query of statements) {
			expect(query).toMatch(/^select\b/i)
			expect(query).not.toMatch(/for update|ContactLink|AI_User|`AI_Contact`/i)
		}
		const [plan] = await pool.query<RowDataPacket[]>(
			'EXPLAIN SELECT * FROM AI_ContactEvent WHERE id = ? LIMIT 1',
			['proof-claim-event'],
		)
		expect(plan[0]?.key).toBe('PRIMARY')
	})
	it('schema rejects SQL NULL without changing the valid canonical snapshot', async () => {
		await expect(
			database
				.update(journeySchema.evergreenOfferJourneyCommit)
				.set({ snapshot: null })
				.where(
					eq(
						journeySchema.evergreenOfferJourneyCommit.stimulusId,
						f.commit.stimulusId,
					),
				),
		).rejects.toMatchObject({ code: 'ER_BAD_NULL_ERROR' })
		expect(await reader()(f.input)).not.toBeNull()
	})
	it.each(
		canonicalOriginProbes.filter(
			(p) => p !== 'missing-normalized-bind' && p !== 'extra-normalized-wake',
		),
	)('real ledger history rejects corruption: %s', async (probe) => {
		expect(await reader()(f.input)).not.toBeNull()
		const stimulusId = f.commit.stimulusId
		const claimId = f.rows[1]!.id
		const originalSnapshot = structuredClone(f.commit.snapshot)
		corruptCanonicalOrigin(f, probe)
		await database
			.update(journeySchema.evergreenOfferJourneyCommit)
			.set(corruptionCommit(f.commit))
			.where(
				eq(journeySchema.evergreenOfferJourneyCommit.stimulusId, stimulusId),
			)
		if (probe === 'null-snapshot' || probe === 'decision-ignored') {
			const [stored] = await database
				.select({
					snapshot: journeySchema.evergreenOfferJourneyCommit.snapshot,
					isSqlNull: sql<number>`${journeySchema.evergreenOfferJourneyCommit.snapshot} is null`,
					jsonType: sql<string>`json_type(${journeySchema.evergreenOfferJourneyCommit.snapshot})`,
				})
				.from(journeySchema.evergreenOfferJourneyCommit)
				.where(
					eq(journeySchema.evergreenOfferJourneyCommit.stimulusId, stimulusId),
				)
			expect(stored?.isSqlNull).toBe(0)
			if (probe === 'null-snapshot') {
				expect(stored?.jsonType).toBe('NULL')
				expect(stored?.snapshot).toBeNull()
			} else {
				expect(stored?.jsonType).toBe('OBJECT')
				expect(stored?.snapshot).toEqual(originalSnapshot)
			}
		}
		await database
			.update(journeySchema.evergreenOfferJourneyIntent)
			.set(f.intentRow)
			.where(
				eq(
					journeySchema.evergreenOfferJourneyIntent.idempotencyKey,
					f.intentRow.idempotencyKey,
				),
			)
		await database
			.update(contactEvent)
			.set(f.rows[1]!)
			.where(eq(contactEvent.id, claimId))
		expect(await reader()(f.input)).toBeNull()
	})
	it('real ledger -> real proof -> coupon bind grants once with the original expiry', async () => {
		const commerce = drizzle(pool, {
			schema: couponCommerceSchema,
			mode: 'default',
		})
		const merchant = {
			id: 'proof-merchant',
			identifier: 'proof-provider',
			merchantAccountId: 'proof-account',
			amountDiscount: 10000,
			status: 1,
			type: 'special',
		}
		await commerce.insert(couponCommerceSchema.merchantCoupon).values(merchant)
		await commerce
			.insert(couponCommerceSchema.entitlementTypes)
			.values({ id: 'proof-credit', name: 'apply_special_credit' })
		const authority = createCouponAuthority({
			store: createMySqlCouponCommerceStore(commerce),
			now: () => f.now,
			merchantCouponEvidence: {
				id: merchant.id,
				identifier: merchant.identifier,
				merchantAccountId: merchant.merchantAccountId,
				currency: 'USD',
				amountOffCents: 10000,
				type: 'special',
				sourceReference: 'synthetic-merchant-readback',
			},
			readVerifiedOwner: reader(),
		})
		const issued = await Effect.runPromise(authority.issue(f.issueIntent))
		expect(issued.coupon.couponId).toBe(f.input.couponId)
		const first = await Effect.runPromise(authority.bind(f.bindIntent))
		expect(await Effect.runPromise(authority.bind(f.bindIntent))).toEqual(first)
		const grants = await commerce
			.select()
			.from(couponCommerceSchema.entitlements)
		expect(grants).toHaveLength(1)
		expect(grants[0]?.userId).toBe(f.input.verifiedUserId)
		expect(grants[0]?.expiresAt?.toISOString()).toBe(f.issueIntent.expiresAt)
	})
	it('refuses a second immutable attestation for the same token/contact, even with a different session', async () => {
		const second = emailTokenLoginEventRow({
			resolution: resolveOwnerContact(
				[f.identity.contactId],
				f.identity.contactId,
			),
			id: 'second-event',
			identity: { ...f.identity, provider: 'kit' },
			payload: {
				...f.login,
				sessionTokenHash: sessionTokenHash(f.secret, 'second-session'),
			},
		})
		await expect(database.insert(contactEvent).values(second)).rejects.toThrow()
		expect(await reader()(f.input)).not.toBeNull()
	})
	it('provenance is checked on real ProviderIdentity rows', async () => {
		await database
			.update(providerIdentity)
			.set({ contactId: 'other' })
			.where(eq(providerIdentity.id, f.identity.id))
		expect(await reader()(f.input)).toBeNull()
	})
	it('reads append-only evidence while another transaction holds identity locks; update waits and later proof fails', async () => {
		const commerce = createMySqlCouponCommerceStore(
			drizzle(pool, { schema: couponCommerceSchema, mode: 'default' }),
		)
		const other = await pool.getConnection()
		try {
			await other.query('SET SESSION innodb_lock_wait_timeout = 1')
			await commerce.withContactLock(f.input.contactId, async (tx) => {
				const user = await tx.getUser(f.input.verifiedUserId)
				if (!user?.emailVerified) throw new Error('Missing fixture user')
				const locked = {
					...f.input,
					lockedContact: tx.lockedContact,
					lockedUser: {
						id: user.id,
						email: user.email,
						emailVerified: user.emailVerified.toISOString(),
					},
				}
				expect(await reader()(locked)).not.toBeNull()
				// Server lock timeout is observable proof of blocking, not a sleep/race guess.
				await expect(
					other.query(
						'UPDATE AI_User SET email = ?, emailVerified = NULL WHERE id = ?',
						['changed@example.test', user.id],
					),
				).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
				expect(await reader()(locked)).not.toBeNull()
			})
			await other.query(
				'UPDATE AI_User SET email = ?, emailVerified = NULL WHERE id = ?',
				['changed@example.test', f.input.verifiedUserId],
			)
			await commerce.withContactLock(f.input.contactId, async (tx) => {
				const user = await tx.getUser(f.input.verifiedUserId)
				if (!user) throw new Error('Missing fixture user')
				expect(
					await reader()({
						...f.input,
						lockedContact: tx.lockedContact,
						lockedUser: {
							id: user.id,
							email: user.email,
							emailVerified: user.emailVerified?.toISOString() ?? null,
						},
					}),
				).toBeNull()
			})
		} finally {
			other.release()
		}
	})
	it('a failing SQL read is typed unavailable rather than absent proof', async () => {
		if (!serverUrl) throw new Error('Missing disposable server')
		const broken = mysql.createPool(
			validateMySqlIntegrationServerUrl(serverUrl).toString(),
		)
		await broken.end()
		{
			const read = createVerifiedOwnerProofReader({
				store: createMySqlVerifiedOwnerEvidenceReadStore(
					drizzle(broken, { schema, mode: 'planetscale' }),
				),
				secret: f.secret,
				now: () => f.now,
			})
			await expect(read(f.input)).rejects.toBeInstanceOf(
				VerifiedOwnerProofUnavailable,
			)
		}
	})
})
