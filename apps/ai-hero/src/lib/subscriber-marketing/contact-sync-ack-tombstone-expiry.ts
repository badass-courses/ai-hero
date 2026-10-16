import { isDeepStrictEqual } from 'node:util'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { contactProfileVersion } from '@/db/contact-sync-schema'
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm'
import { readAckTombstone } from './contact-sync-ack-tombstone'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { lockProfileAckVersion } from './contact-sync-profile-ack-lookup'
import {
	profileAckRetirementFor,
	stageProfileAckRetirement,
} from './contact-sync-profile-ack-retirement'
import {
	ACK_TOMBSTONE_MAX_AGE_MS,
	ACK_TOMBSTONE_STATUS,
} from './contact-sync-profile-ack-schema'
import {
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'

const BATCH = 500
const CHUNK = 128
type Database = typeof import('@/db').db
async function databaseClock(database: unknown): Promise<string> {
	const db = database as Pick<Database, 'execute'>
	const response: unknown = await db.execute(
		sql`SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`,
	)
	const outer = response as unknown[]
	const row = (Array.isArray(outer?.[0]) ? outer[0][0] : outer?.[0]) as
		| { nowUtc?: unknown }
		| undefined
	if (
		typeof row?.nowUtc !== 'string' ||
		!Number.isFinite(Date.parse(row.nowUtc))
	)
		throw new ProfileAckConflict(
			'dedicated marker expiry has no positive database UTC authority',
		)
	return new Date(row.nowUtc).toISOString()
}

/** Dedicated control-only expiry, never generic delivered-row retention.
 * Caller runs this only AFTER a native purge tick which was not refused.
 * OFF/unknown invokes neither transaction nor deletion. The contact-first
 * authority lock, all surviving native retirement fences, and exact marker
 * deletion share one transaction. No pins, re-capture, broker or HTTP ports.
 */
export async function expireAckTombstones(args: {
	database: unknown
	target: string
	enabled: () => Promise<boolean>
}): Promise<number> {
	const enabled = () => profileAckFlagEnabled({ readFlag: args.enabled })
	if (!(await enabled())) return 0
	const db = args.database as Pick<Database, 'transaction'>
	if (typeof db?.transaction !== 'function')
		throw new ProfileAckConflict(
			'dedicated marker expiry cannot provide a contact-first transaction',
		)
	return writeHeldContinuationGuard(() =>
		retryHeldBatchTransaction(async () => {
			if (!(await enabled())) return 0
			return db.transaction(async (tx) => {
				const now = await databaseClock(tx)
				const before = new Date(Date.parse(now) - ACK_TOMBSTONE_MAX_AGE_MS)
					.toISOString()
					.slice(0, 23)
					.replace('T', ' ')
				// Missing version is NOT positive version-change proof. The explicit
				// predicate avoids a permanently stuck first500 young marker page.
				const candidates = await tx
					.select({
						id: drovrOutbox.id,
						key: drovrOutbox.dedupeKey,
						contactId: drovrOutbox.contactId,
					})
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, args.target),
							eq(drovrOutbox.status, ACK_TOMBSTONE_STATUS),
							or(
								lte(drovrOutbox.createdAt, before),
								sql`EXISTS (SELECT 1 FROM ${contactProfileVersion} WHERE ${contactProfileVersion.contactId} = ${drovrOutbox.contactId} AND ${contactProfileVersion.profileVersion} <> JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.profileAck.ref.profileVersion'))`,
							),
						),
					)
					.orderBy(asc(drovrOutbox.createdAt), asc(drovrOutbox.dedupeKey))
					.limit(BATCH)
				if (!candidates.length) return 0
				const versions = new Map<string, number | undefined>()
				for (const contactId of [
					...new Set(candidates.map((row) => row.contactId)),
				].sort()) {
					const version = await lockProfileAckVersion(tx, contactId)
					versions.set(
						contactId,
						version == null ? undefined : Number(version.profileVersion),
					)
				}
				const markers: (typeof drovrOutbox.$inferSelect)[] = []
				const ids = [...candidates]
					.sort((a, b) => a.key.localeCompare(b.key))
					.map((row) => row.id)
				for (let offset = 0; offset < ids.length; offset += CHUNK)
					markers.push(
						...(await tx
							.select()
							.from(drovrOutbox)
							.where(
								and(
									eq(drovrOutbox.target, args.target),
									eq(drovrOutbox.status, ACK_TOMBSTONE_STATUS),
									inArray(drovrOutbox.id, ids.slice(offset, offset + CHUNK)),
								),
							)
							.orderBy(asc(drovrOutbox.dedupeKey))
							.for('update')),
					)
				let deleted = 0
				for (const markerRow of markers) {
					const original = candidates.find((row) => row.id === markerRow.id)
					if (
						!original ||
						original.key !== markerRow.dedupeKey ||
						original.contactId !== markerRow.contactId
					)
						throw new ProfileAckConflict(
							'the locked marker identity changed after contact-first expiry admission',
						)
					const marker = readAckTombstone(markerRow)
					const retirement = profileAckRetirementFor(marker, {
						now: Date.parse(now),
						currentVersion: versions.get(marker.ref.contactId),
					})
					if (!retirement) continue
					// RequestId alone cannot admit foreign bytes; every row is decoded
					// and checked against ALL original scoped reference components.
					const nativeKeys = await tx
						.select({ dedupeKey: drovrOutbox.dedupeKey })
						.from(drovrOutbox)
						.where(
							and(
								eq(drovrOutbox.target, marker.ref.target),
								eq(drovrOutbox.contactId, marker.ref.contactId),
								inArray(drovrOutbox.eventType, [
									'contact.profile.updated',
									'contact.links.issued',
								]),
								sql`JSON_UNQUOTE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.profileAck.ref.requestId')) = ${marker.ref.requestId}`,
							),
						)
						.orderBy(asc(drovrOutbox.dedupeKey))
						.limit(1025)
						.for('update')
					if (nativeKeys.length > 1024)
						throw new ProfileAckConflict(
							'dedicated marker retirement exceeds its original native reference budget',
						)
					const native: {
						target: string
						dedupeKey: string
						heldContinuation: unknown
					}[] = []
					for (let offset = 0; offset < nativeKeys.length; offset += CHUNK)
						native.push(
							...(await tx
								.select({
									target: drovrOutbox.target,
									dedupeKey: drovrOutbox.dedupeKey,
									heldContinuation: drovrOutbox.heldContinuation,
								})
								.from(drovrOutbox)
								.where(
									and(
										eq(drovrOutbox.target, marker.ref.target),
										eq(drovrOutbox.contactId, marker.ref.contactId),
										inArray(
											drovrOutbox.dedupeKey,
											nativeKeys
												.slice(offset, offset + CHUNK)
												.map((row) => row.dedupeKey),
										),
									),
								)
								.orderBy(asc(drovrOutbox.dedupeKey))
								.for('update')),
						)
					if (native.length !== nativeKeys.length)
						throw new ProfileAckConflict(
							'dedicated marker retirement lost an original member during its strict locking read',
						)
					const changes = stageProfileAckRetirement({
						markerRow,
						retirement,
						rows: native,
					})
					// Usually two shapes (coordinator + members), but other independent
					// controls may differ. Never overwrite or truncate those members.
					const groups = new Map<string, string[]>()
					for (const change of changes) {
						const group = groups.get(change.encoded) ?? []
						group.push(change.dedupeKey)
						groups.set(change.encoded, group)
					}
					for (const [encoded, keys] of groups)
						for (let offset = 0; offset < keys.length; offset += CHUNK)
							await tx
								.update(drovrOutbox)
								.set({ heldContinuation: sql`JSON_EXTRACT(${encoded}, '$')` })
								.where(
									and(
										eq(drovrOutbox.target, marker.ref.target),
										inArray(
											drovrOutbox.dedupeKey,
											keys.slice(offset, offset + CHUNK),
										),
									),
								)
					// Prove installation before deleting the only dedicated marker.
					for (let offset = 0; offset < changes.length; offset += CHUNK) {
						const chunk = changes.slice(offset, offset + CHUNK)
						const fresh = await tx
							.select({
								dedupeKey: drovrOutbox.dedupeKey,
								heldContinuation: drovrOutbox.heldContinuation,
							})
							.from(drovrOutbox)
							.where(
								and(
									eq(drovrOutbox.target, marker.ref.target),
									inArray(
										drovrOutbox.dedupeKey,
										chunk.map((item) => item.dedupeKey),
									),
								),
							)
							.for('update')
						if (
							fresh.length !== chunk.length ||
							fresh.some((row) => {
								const state = readHeldContinuationEnvelope(
									row.heldContinuation,
								)?.profileAck
								return (
									!state ||
									state.role === 'tombstone' ||
									state.retirement?.createdAt !== retirement.createdAt ||
									state.retirement?.expiresAt !== retirement.expiresAt ||
									!isDeepStrictEqual(
										readHeldContinuationEnvelope(row.heldContinuation),
										readHeldContinuationEnvelope(
											chunk.find((change) => change.dedupeKey === row.dedupeKey)
												?.encoded,
										),
									)
								)
							})
						)
							throw new ProfileAckConflict(
								'marker expiry did not retain every original native negative lifetime fence',
							)
					}
					const result = await tx
						.delete(drovrOutbox)
						.where(
							and(
								eq(drovrOutbox.id, markerRow.id),
								eq(drovrOutbox.target, marker.ref.target),
								eq(drovrOutbox.status, ACK_TOMBSTONE_STATUS),
							),
						)
					const header = (Array.isArray(result)
						? result[0]
						: result) as unknown as {
						affectedRows?: number
						rowsAffected?: number
					}
					if (Number(header?.affectedRows ?? header?.rowsAffected) !== 1)
						throw new ProfileAckConflict(
							'the exact dedicated marker deletion did not commit one original control row',
						)
					deleted++
				}
				return deleted
			})
		}),
	)
}
