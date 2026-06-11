import { db } from '@/db'
import { contentRead } from '@/db/schema'
import { and, count, isNull, lt } from 'drizzle-orm'

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

export async function deleteExpiredAnonymousContentReads(args?: {
	retentionDays?: number
	now?: Date
}): Promise<AnonymousContentReadRetentionResult> {
	const preview = await previewExpiredAnonymousContentReads(args)
	const { cutoff } = getRetentionCutoff(args)
	const result = await db
		.delete(contentRead)
		.where(expiredAnonymousContentReadWhere(cutoff))

	return {
		...preview,
		mode: 'write',
		deletedCount: Number(result.rowsAffected ?? 0),
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
