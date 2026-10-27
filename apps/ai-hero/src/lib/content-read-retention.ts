import { db } from '@/db'
import { contentRead } from '@/db/schema'
import { and, asc, count, inArray, isNull, lt } from 'drizzle-orm'

export const ANONYMOUS_CONTENT_READ_RETENTION_DAYS = 14

export type AnonymousContentReadRetentionResult = {
	mode: 'dry-run' | 'write'
	retentionDays: number
	cutoff: string
	candidateCount: number
	deletedCount: number
}

export async function previewExpiredAnonymousContentReads(args?: {
	retentionDays?: number
	now?: Date
}): Promise<AnonymousContentReadRetentionResult> {
	const { retentionDays, cutoff } = getRetentionCutoff(args)
	const rows = await db
		.select({ count: count() })
		.from(contentRead)
		.where(expiredAnonymousContentReadWhere(cutoff))
	return {
		mode: 'dry-run',
		retentionDays,
		cutoff: cutoff.toISOString(),
		candidateCount: Number(rows[0]?.count ?? 0),
		deletedCount: 0,
	}
}

export const CONTENT_READ_RETENTION_BATCH_SIZE = 1000
export const CONTENT_READ_RETENTION_MAX_BATCHES = 200

export type ContentReadRetentionBatchResult = {
	selectedCount: number
	deletedCount: number
}

/**
 * Deletes at most one bounded batch of expired anonymous rows. The range key is
 * the indexed `occurredAt` column; `createdAt < cutoff` stays on the delete so
 * the removed rows are a subset of the full-table predicate.
 */
export async function deleteExpiredAnonymousContentReadBatch(args: {
	cutoff: Date
	batchSize?: number
}): Promise<ContentReadRetentionBatchResult> {
	const batchSize = args.batchSize ?? CONTENT_READ_RETENTION_BATCH_SIZE
	const rows = await db
		.select({ id: contentRead.id })
		.from(contentRead)
		.where(
			and(
				expiredAnonymousContentReadWhere(args.cutoff),
				lt(contentRead.occurredAt, args.cutoff),
			),
		)
		.orderBy(asc(contentRead.occurredAt))
		.limit(batchSize)
	if (rows.length === 0) return { selectedCount: 0, deletedCount: 0 }

	const result = await db.delete(contentRead).where(
		and(
			inArray(
				contentRead.id,
				rows.map((row) => row.id),
			),
			expiredAnonymousContentReadWhere(args.cutoff),
		),
	)
	return {
		selectedCount: rows.length,
		deletedCount: Number(result.rowsAffected ?? 0),
	}
}

export function getContentReadRetentionCutoff(args?: {
	retentionDays?: number
	now?: Date
}) {
	return getRetentionCutoff(args)
}

export async function deleteExpiredAnonymousContentReads(args?: {
	retentionDays?: number
	now?: Date
	batchSize?: number
	maxBatches?: number
}): Promise<AnonymousContentReadRetentionResult> {
	const { retentionDays, cutoff } = getRetentionCutoff(args)
	const batchSize = args?.batchSize ?? CONTENT_READ_RETENTION_BATCH_SIZE
	const maxBatches = args?.maxBatches ?? CONTENT_READ_RETENTION_MAX_BATCHES
	let deletedCount = 0
	for (let batch = 0; batch < maxBatches; batch++) {
		const result = await deleteExpiredAnonymousContentReadBatch({
			cutoff,
			batchSize,
		})
		deletedCount += result.deletedCount
		if (result.selectedCount < batchSize) break
	}

	return {
		mode: 'write',
		retentionDays,
		cutoff: cutoff.toISOString(),
		candidateCount: deletedCount,
		deletedCount,
	}
}

function getRetentionCutoff(args?: { retentionDays?: number; now?: Date }) {
	const retentionDays =
		args?.retentionDays ?? ANONYMOUS_CONTENT_READ_RETENTION_DAYS
	const now = args?.now ?? new Date()
	const cutoff = new Date(now)
	cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
	return { retentionDays, cutoff }
}

function expiredAnonymousContentReadWhere(cutoff: Date) {
	return and(
		isNull(contentRead.contactId),
		isNull(contentRead.userId),
		isNull(contentRead.kitSubscriberId),
		isNull(contentRead.emailSha256),
		lt(contentRead.createdAt, cutoff),
	)
}
