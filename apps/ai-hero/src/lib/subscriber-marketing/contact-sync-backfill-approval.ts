import { createHash, randomUUID } from 'node:crypto'
import { NonRetriableError } from 'inngest'
import type { BackfillCursor } from './contact-sync-backfill'

export type BackfillApprovalBinding = {
	kind: 'canary' | 'continue'
	rows: number
	cursor?: BackfillCursor
}
export type BackfillApprovals = {
	issue(binding: BackfillApprovalBinding): Promise<string>
	consume(token: string, binding: BackfillApprovalBinding): Promise<boolean>
}
export function approvalDigest(binding: BackfillApprovalBinding) {
	const cursor = binding.cursor
	return createHash('sha256')
		.update(
			JSON.stringify([
				binding.kind,
				binding.rows,
				cursor?.phase ?? null,
				cursor?.afterOccurredAt ?? null,
				cursor?.afterId ?? null,
				cursor?.nextStampMs ?? null,
			]),
		)
		.digest('hex')
}
export async function requireBoundBackfillApproval(
	input: {
		approvalToken?: string
		dryRunCount?: number
		cursor?: BackfillCursor
	},
	store?: BackfillApprovals,
) {
	const valid =
		store &&
		input.approvalToken &&
		Number.isSafeInteger(input.dryRunCount) &&
		(await store.consume(input.approvalToken, {
			kind: input.cursor === undefined ? 'canary' : 'continue',
			rows: input.dryRunCount!,
			cursor: input.cursor,
		}))
	if (!valid)
		throw new NonRetriableError(
			'BackfillApproval: you requested a backfill slice, and it failed because its count/cursor approval is absent, expired, used or mismatched. Accepted: the exact single-use approvalToken from the preceding successful canary/slice receipt. Fix: run a fresh count, inspect one contact, then explicitly approve each returned cursor. Debug: compare the count and cursor with the receipt; booleans cannot grant approval.',
		)
}
/** Opaque single-use approvals use the existing cursor table, never a new key
 * or schema. Only a digest is persisted; it binds count, phase and full cursor.
 * Deleting the matching unexpired row consumes the grant atomically.
 */
export function createDrizzleBackfillApprovals(
	database: unknown,
	now = () => Date.now(),
): BackfillApprovals {
	const db = database as {
		insert(table: unknown): { values(values: unknown): Promise<unknown> }
		delete(table: unknown): { where(clause: unknown): Promise<unknown> }
	}
	return {
		async issue(binding) {
			const [{ contactSyncCursor }, { sql }] = await Promise.all([
				import('@/db/contact-sync-schema'),
				import('drizzle-orm'),
			])
			const token = randomUUID()
			await db.insert(contactSyncCursor).values({
				name: `backfill-approval:${token}`,
				cursor: approvalDigest(binding),
				watermark: sql`FROM_UNIXTIME(${Math.floor((now() + 86400000) / 1000)})`,
			})
			return token
		},
		async consume(token, binding) {
			const [{ contactSyncCursor }, { and, eq, gt, sql }] = await Promise.all([
				import('@/db/contact-sync-schema'),
				import('drizzle-orm'),
			])
			const result = (await db
				.delete(contactSyncCursor)
				.where(
					and(
						eq(contactSyncCursor.name, `backfill-approval:${token}`),
						eq(contactSyncCursor.cursor, approvalDigest(binding)),
						gt(contactSyncCursor.watermark, sql`CURRENT_TIMESTAMP(3)`),
					),
				)) as
				| { rowsAffected?: number; affectedRows?: number }
				| [{ affectedRows: number }]
			const header = (Array.isArray(result) ? result[0] : result) as {
				rowsAffected?: number
				affectedRows?: number
			}
			return (header.rowsAffected ?? header.affectedRows) === 1
		},
	}
}
