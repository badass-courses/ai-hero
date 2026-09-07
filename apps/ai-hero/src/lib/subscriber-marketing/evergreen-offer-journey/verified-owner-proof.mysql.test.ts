import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { contact, contactEvent, providerIdentity, users } from '@/db/schema'
import * as journeySchema from '@/db/evergreen-offer-journey-schema'
import { eq } from 'drizzle-orm'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateMySqlIntegrationServerUrl } from '../../team-purchase-mysql-test-guard'
import {
	createMySqlVerifiedOwnerEvidenceReadStore,
	createVerifiedOwnerProofReader,
	VerifiedOwnerProofUnavailable,
} from './verified-owner-proof'
import { ownerProofFixture } from './verified-owner-proof.fixtures'
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
		database = drizzle(pool, {
			schema,
			mode: 'default',
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
		await database
			.insert(journeySchema.evergreenOfferJourneyCommit)
			.values(f.commit)
		await database
			.insert(journeySchema.evergreenOfferJourneyIntent)
			.values(f.intentRow)
		statements.length = 0
	})
	const reader = () =>
		createVerifiedOwnerProofReader({
			store: createMySqlVerifiedOwnerEvidenceReadStore(database),
			secret: f.secret,
			now: () => f.now,
		})
	it('uses five bounded exact indexed SELECTs, no live identity/ContactLink query and no writes', async () => {
		expect(await reader()(f.input)).toMatchObject({
			sourceReference: 'contact-event:proof-claim-event',
		})
		expect(statements).toHaveLength(5)
		for (const query of statements) {
			expect(query).toMatch(/^select\b/i)
			expect(query).toMatch(/limit \?/i)
			expect(query).not.toMatch(/for update|ContactLink|AI_User|`AI_Contact`/i)
		}
		const [plan] = await pool.query<RowDataPacket[]>(
			'EXPLAIN SELECT * FROM AI_ContactEvent WHERE id = ? LIMIT 1',
			['proof-claim-event'],
		)
		expect(plan[0]?.key).toBe('PRIMARY')
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
				store: createMySqlVerifiedOwnerEvidenceReadStore(drizzle(broken)),
				secret: f.secret,
				now: () => f.now,
			})
			await expect(read(f.input)).rejects.toBeInstanceOf(
				VerifiedOwnerProofUnavailable,
			)
		}
	})
})
