import { and, eq, getTableColumns, is, like, lte } from 'drizzle-orm'
import {
	MySqlTable,
	type MySqlColumn,
	type MySqlDatabase,
} from 'drizzle-orm/mysql-core'

import * as schema from '@/db/schema'
import {
	contact,
	contactState,
	signupAttribution,
	users,
	verificationTokens,
} from '@/db/schema'
import {
	SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN,
	SYNTHETIC_PRINCIPAL_ID_LIKE,
} from '@/lib/synthetic-principal'
import { contactEmailWriteValues } from '@/lib/subscriber-marketing/contact-email-equivalence'
import { CONTACT_STATE_SCHEMA_VERSION } from '@/lib/subscriber-marketing/types'

import {
	MAGIC_LINK_REUSE_WINDOW_MS,
	MAX_LIVE_TEST_PRINCIPALS,
	TEST_PRINCIPAL_TTL_MS,
	testPrincipalIdentity,
	type TestPrincipalIdentity,
} from './test-principal'

// Every delete and lookup carries a second, independent guard: the row's key
// must itself be synthetic.
const SYNTHETIC_ID_LIKE = SYNTHETIC_PRINCIPAL_ID_LIKE
const SYNTHETIC_EMAIL_LIKE = `%@${SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN}`

// Any drizzle MySQL database: the app's pool or a disposable test database.
type Database = MySqlDatabase<any, any, any>

/** A table keyed to a principal by one of these columns. */
type KeyedTable = {
	name: string
	table: MySqlTable
	column: 'userId' | 'contactId'
	key: MySqlColumn
}

/**
 * Every app table with a userId or contactId column, read from the schema
 * itself so a table added later is cleaned without anyone remembering to.
 */
export function principalKeyedTables(): KeyedTable[] {
	const keyed: KeyedTable[] = []
	for (const value of Object.values(schema)) {
		if (!is(value, MySqlTable)) continue
		const columns: Record<string, MySqlColumn | undefined> =
			getTableColumns(value)
		const name = tableName(value)
		for (const column of ['userId', 'contactId'] as const) {
			const key = columns[column]
			if (key) keyed.push({ name, table: value, column, key })
		}
	}
	return keyed
}

function tableName(table: MySqlTable): string {
	return (table as unknown as Record<symbol, string>)[
		Symbol.for('drizzle:Name')
	]!
}

function affected(result: unknown): number {
	return Number((result as { rowsAffected?: number }).rowsAffected ?? 0)
}

export type MintedPrincipalRecords =
	| {
			status: 'minted' | 'existing'
			identity: TestPrincipalIdentity
			createdAt: Date
			expiresAt: Date
	  }
	| { status: 'limit'; live: number }

/**
 * Create (or reuse, within its hour) the principal for a runId and replace
 * its one outstanding sign-in token. Direct inserts: no Auth.js createUser
 * event, so nothing reaches USER_CREATED, Kit, or organization provisioning.
 */
export async function mintTestPrincipalRecords(
	database: Database,
	args: { runId: string; now: Date; tokenHash: string; tokenExpires: Date },
): Promise<MintedPrincipalRecords> {
	const identity = testPrincipalIdentity(args.runId)
	return retryOnMintConflict(() =>
		database.transaction(async (tx) => {
			// One locking read over the synthetic id range is both the lookup and
			// the live count. Its next-key locks make concurrent mints (same runId
			// or not) wait for each other, so the cap and the insert are atomic; a
			// deadlock or duplicate key from a race retries the whole mint.
			const principals = await tx
				.select({ id: users.id, createdAt: users.createdAt })
				.from(users)
				.where(like(users.id, SYNTHETIC_ID_LIKE))
				.for('update')
			const existing = principals.find((row) => row.id === identity.principalId)
			const liveSince = new Date(args.now.getTime() - TEST_PRINCIPAL_TTL_MS)
			const isLive = (row: { createdAt: Date | null }) =>
				row.createdAt != null && row.createdAt > liveSince
			const reusable = existing != null && isLive(existing)
			let createdAt: Date
			if (reusable) {
				createdAt = existing.createdAt!
			} else {
				// An expired principal for this runId starts over, never extends.
				if (existing) await deletePrincipalRows(tx, identity)
				const liveCount = principals.filter(isLive).length
				if (liveCount >= MAX_LIVE_TEST_PRINCIPALS) {
					return { status: 'limit', live: liveCount } as const
				}
				createdAt = args.now
				await tx.insert(users).values({
					id: identity.principalId,
					email: identity.email,
					name: `Link test ${args.runId}`,
					emailVerified: args.now,
					createdAt: args.now,
				})
				await tx.insert(contact).values({
					id: identity.contactId,
					userId: identity.principalId,
					...contactEmailWriteValues(identity.email),
					lifecycle: 'new',
					isProvisional: true,
					createdAt: args.now,
					updatedAt: args.now,
				})
				// Personalize reads the contact's state; without one every emailKey
				// comes back stale-state with no variables. Shaped like a real
				// signup's (human-review, low confidence) and marked synthetic.
				await tx.insert(contactState).values({
					contactId: identity.contactId,
					lifecycle: 'human-review',
					primaryBucket: 'other-unclear',
					allBuckets: ['other-unclear'],
					whySignals: [],
					whoSignals: [],
					confidence: '0',
					rationale: ['Synthetic test principal (#36T); not a real signup.'],
					reviewSignals: ['synthetic-principal'],
					humanReview: true,
					lastEventId: `test-principal:${args.runId}`,
					schemaVersion: CONTACT_STATE_SCHEMA_VERSION,
					updatedAt: args.now,
				})
			}
			await tx
				.delete(verificationTokens)
				.where(
					and(
						eq(verificationTokens.identifier, identity.email),
						like(verificationTokens.identifier, SYNTHETIC_EMAIL_LIKE),
					),
				)
			await tx.insert(verificationTokens).values({
				identifier: identity.email,
				token: args.tokenHash,
				expires: args.tokenExpires,
				// CourseBuilder's adapter keeps a magic link reusable for 90s after
				// createdAt (email scanners click first). A test principal's link is
				// one-time: start it past that window so its first use consumes it.
				createdAt: new Date(
					args.now.getTime() - MAGIC_LINK_REUSE_WINDOW_MS - 1_000,
				),
			})
			return {
				status: reusable ? 'existing' : 'minted',
				identity,
				createdAt,
				expiresAt: new Date(createdAt.getTime() + TEST_PRINCIPAL_TTL_MS),
			} as const
		}),
	)
}

const mysqlErrno = (error: unknown) =>
	(error as { errno?: number }).errno ??
	(error as { cause?: { errno?: number } }).cause?.errno

/** A concurrent mint lost a race (1062 duplicate key, 1213 deadlock): retry. */
async function retryOnMintConflict<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run()
		} catch (error) {
			const errno = mysqlErrno(error)
			if (attempt >= 5 || (errno !== 1062 && errno !== 1213)) throw error
			await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
		}
	}
}

export type PrincipalRemovalReceipt = {
	removed: Record<string, number>
	/** Schema tables this database does not have (MySQL 1146), so nothing to clean. */
	absentTables: string[]
}

const isMissingTable = (error: unknown) =>
	(error as { errno?: number; cause?: { errno?: number } }).errno === 1146 ||
	(error as { cause?: { errno?: number } }).cause?.errno === 1146

async function deletePrincipalRows(
	database: Database,
	identity: TestPrincipalIdentity,
): Promise<PrincipalRemovalReceipt> {
	const removed: Record<string, number> = {}
	const absentTables: string[] = []
	const note = (name: string, result: unknown) => {
		const rows = affected(result)
		if (rows > 0) removed[name] = (removed[name] ?? 0) + rows
	}
	// A failed statement alone rolls back in MySQL; the transaction goes on.
	// Only a missing table is tolerated; any other error aborts the cleanup.
	const attempt = async (name: string, run: () => Promise<unknown>) => {
		try {
			note(name, await run())
		} catch (error) {
			if (!isMissingTable(error)) throw error
			if (!absentTables.includes(name)) absentTables.push(name)
		}
	}
	for (const { name, table, column, key } of principalKeyedTables()) {
		const id = column === 'userId' ? identity.principalId : identity.contactId
		await attempt(name, () =>
			database
				.delete(table)
				.where(and(eq(key, id), like(key, SYNTHETIC_ID_LIKE))),
		)
	}
	note(
		'AI_Contact',
		await database
			.delete(contact)
			.where(
				and(
					eq(contact.id, identity.contactId),
					like(contact.id, SYNTHETIC_ID_LIKE),
				),
			),
	)
	note(
		'AI_VerificationToken',
		await database
			.delete(verificationTokens)
			.where(
				and(
					eq(verificationTokens.identifier, identity.email),
					like(verificationTokens.identifier, SYNTHETIC_EMAIL_LIKE),
				),
			),
	)
	await attempt('AI_SignupAttribution', () =>
		database
			.delete(signupAttribution)
			.where(
				and(
					eq(signupAttribution.email, identity.email),
					like(signupAttribution.email, SYNTHETIC_EMAIL_LIKE),
				),
			),
	)
	note(
		'AI_User',
		await database
			.delete(users)
			.where(
				and(
					eq(users.id, identity.principalId),
					like(users.id, SYNTHETIC_ID_LIKE),
				),
			),
	)
	return { removed, absentTables }
}

/**
 * Remove a principal and everything keyed to it, in one transaction.
 * Returns null when nothing was there (the caller answers 204).
 */
export async function deleteTestPrincipalRecords(
	database: Database,
	principalId: string,
	options: {
		/** The reaper's cutoff: skip a principal re-minted since it was listed. */
		createdBefore?: Date
	} = {},
): Promise<
	({ identity: TestPrincipalIdentity } & PrincipalRemovalReceipt) | null
> {
	return database.transaction(async (tx) => {
		const [user] = await tx
			.select({ email: users.email, createdAt: users.createdAt })
			.from(users)
			.where(and(eq(users.id, principalId), like(users.id, SYNTHETIC_ID_LIKE)))
			.for('update')
		if (!user?.email) return null
		if (
			options.createdBefore &&
			(user.createdAt == null || user.createdAt >= options.createdBefore)
		)
			return null
		// The address carries the runId; rebuild the identity from it.
		const runId = user.email.slice(0, user.email.indexOf('@'))
		const identity = testPrincipalIdentity(runId)
		if (identity.principalId !== principalId) return null
		return { identity, ...(await deletePrincipalRows(tx, identity)) }
	})
}

/** Principals older than their hour, oldest first, for the reaper. */
export async function expiredTestPrincipalIds(
	database: Database,
	args: { now: Date; limit: number },
): Promise<string[]> {
	const rows = await database
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				like(users.id, SYNTHETIC_ID_LIKE),
				lte(
					users.createdAt,
					new Date(args.now.getTime() - TEST_PRINCIPAL_TTL_MS),
				),
			),
		)
		.orderBy(users.createdAt)
		.limit(args.limit)
	return rows.map((row) => row.id)
}
