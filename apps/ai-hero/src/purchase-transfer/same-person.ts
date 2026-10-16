/**
 * Same-person evidence for support-completed transfers.
 *
 * Readers treat a missing `PurchaseTransferSamePerson` table as "no flags":
 * that is the #439 answer, so a deploy that lands before the migration keeps
 * every invoice page working. The writer does the opposite and refuses, so a
 * move is never completed without its flag recorded.
 */
import { db } from '@/db'
import { purchaseTransferSamePerson } from '@/db/schema'
import {
	isSamePersonKind,
	SAME_PERSON_LIMITS,
	type InvoiceTransferFact,
	type SamePersonEvidence,
	type SamePersonFlag,
} from '@/lib/invoice-access-rules'
import { log } from '@/server/logger'
import { inArray, sql } from 'drizzle-orm'

type SamePersonExecutor = Pick<typeof db, 'insert'>

let missingTableLogged = false

export function isMissingTableError(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; current && depth < 5; depth++) {
		const candidate = current as {
			code?: unknown
			errno?: unknown
			cause?: unknown
		}
		if (
			candidate.code === 'ER_NO_SUCH_TABLE' ||
			candidate.errno === 1146
		) {
			return true
		}
		current = candidate.cause
	}
	return false
}

/**
 * Same-person flags by transfer id, for readers. Reads only the transfer id
 * and `verifiedBy`; `reason` and `proofRef` are checked in the query and never
 * leave the database. The check mirrors `isValidSamePersonEvidence`: trimmed
 * reason 1 to 1000 characters, trimmed proofRef 1 to 255 with no `@`. A row
 * that fails it is no flag. A missing table returns an empty map and logs once
 * per process.
 */
export async function loadSamePersonFlags(
	transferIds: string[],
): Promise<Map<string, SamePersonFlag>> {
	const flags = new Map<string, SamePersonFlag>()
	if (transferIds.length === 0) return flags
	const t = purchaseTransferSamePerson
	let rows
	try {
		rows = await db
			.select({
				transferId: t.transferId,
				verifiedBy: t.verifiedBy,
				evidenceOk: sql<number>`(CHAR_LENGTH(TRIM(${t.reason})) BETWEEN 1 AND ${SAME_PERSON_LIMITS.reason} AND CHAR_LENGTH(TRIM(${t.proofRef})) BETWEEN 1 AND ${SAME_PERSON_LIMITS.proofRef} AND INSTR(${t.proofRef}, '@') = 0)`,
			})
			.from(t)
			.where(inArray(t.transferId, transferIds))
	} catch (error) {
		if (!isMissingTableError(error)) throw error
		if (!missingTableLogged) {
			missingTableLogged = true
			await log.error('purchase_transfer.same_person_table_missing', {})
		}
		return flags
	}
	for (const row of rows) {
		if (Number(row.evidenceOk) === 1 && isSamePersonKind(row.verifiedBy)) {
			flags.set(row.transferId, { verifiedBy: row.verifiedBy })
		}
	}
	return flags
}

type CompletedTransferRow = {
	id: string
	transferState: string
	sourceUserId: string
	targetUserId: string | null
	completedAt: Date | null
	createdAt: Date
}

/** The one place a transfer row becomes an `InvoiceTransferFact`. */
export async function toTransferFacts(
	rows: CompletedTransferRow[],
): Promise<InvoiceTransferFact[]> {
	const flags = await loadSamePersonFlags(rows.map((row) => row.id))
	return rows.map((row) => ({
		id: row.id,
		state: row.transferState,
		sourceUserId: row.sourceUserId,
		targetUserId: row.targetUserId,
		completedAt: row.completedAt,
		createdAt: row.createdAt,
		samePerson: flags.get(row.id) ?? null,
	}))
}

/** The writer checks this first: it never completes a move without its flag. */
export async function samePersonTableExists(): Promise<boolean> {
	try {
		await db
			.select({ id: purchaseTransferSamePerson.transferId })
			.from(purchaseTransferSamePerson)
			.limit(1)
		return true
	} catch (error) {
		if (isMissingTableError(error)) return false
		throw error
	}
}

/**
 * Idempotent insert for use inside the VERIFIED claim transaction. A resumed
 * move writes the same row again, which is a no-op.
 */
export async function recordSamePersonEvidence(
	executor: SamePersonExecutor,
	transferId: string,
	evidence: SamePersonEvidence,
) {
	await executor
		.insert(purchaseTransferSamePerson)
		.values({
			transferId,
			verifiedBy: evidence.verifiedBy,
			reason: evidence.reason.trim(),
			proofRef: evidence.proofRef.trim(),
		})
		.onDuplicateKeyUpdate({
			set: { transferId: sql`${purchaseTransferSamePerson.transferId}` },
		})
}
