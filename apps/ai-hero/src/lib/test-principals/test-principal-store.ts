import { and, count, eq, getTableColumns, gt, is, like, lte } from 'drizzle-orm'
import {
	MySqlTable,
	type MySqlColumn,
	type MySqlDatabase,
} from 'drizzle-orm/mysql-core'

import * as schema from '@/db/schema'
import {
	contact,
	signupAttribution,
	users,
	verificationTokens,
} from '@/db/schema'
import {
	SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN,
	SYNTHETIC_PRINCIPAL_ID_LIKE,
} from '@/lib/synthetic-principal'
import { contactEmailWriteValues } from '@/lib/subscriber-marketing/contact-email-equivalence'

import {
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
	return database.transaction(async (tx) => {
		const [existing] = await tx
			.select({ createdAt: users.createdAt })
			.from(users)
			.where(
				and(eq(users.id, identity.principalId), like(users.id, SYNTHETIC_ID_LIKE)),
			)
		const liveSince = new Date(args.now.getTime() - TEST_PRINCIPAL_TTL_MS)
		const reusable =
			existing?.createdAt != null && existing.createdAt > liveSince
		let createdAt: Date
		if (reusable) {
			createdAt = existing.createdAt!
		} else {
			// An expired principal for this runId starts over, never extends.
			if (existing) await deletePrincipalRows(tx, identity)
			const [live] = await tx
				.select({ live: count() })
				.from(users)
				.where(and(like(users.id, SYNTHETIC_ID_LIKE), gt(users.createdAt, liveSince)))
			const liveCount = Number(live?.live ?? 0)
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
		})
		return {
			status: reusable ? 'existing' : 'minted',
			identity,
			createdAt,
			expiresAt: new Date(createdAt.getTime() + TEST_PRINCIPAL_TTL_MS),
		} as const
	})
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
			database.delete(table).where(and(eq(key, id), like(key, SYNTHETIC_ID_LIKE))),
		)
	}
	note(
		'AI_Contact',
		await database
			.delete(contact)
			.where(and(eq(contact.id, identity.contactId), like(contact.id, SYNTHETIC_ID_LIKE))),
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
			.where(and(eq(users.id, identity.principalId), like(users.id, SYNTHETIC_ID_LIKE))),
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
): Promise<({ identity: TestPrincipalIdentity } & PrincipalRemovalReceipt) | null> {
	return database.transaction(async (tx) => {
		const [user] = await tx
			.select({ email: users.email })
			.from(users)
			.where(and(eq(users.id, principalId), like(users.id, SYNTHETIC_ID_LIKE)))
		if (!user?.email) return null
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
				lte(users.createdAt, new Date(args.now.getTime() - TEST_PRINCIPAL_TTL_MS)),
			),
		)
		.orderBy(users.createdAt)
		.limit(args.limit)
	return rows.map((row) => row.id)
}
