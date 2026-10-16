import { randomUUID } from 'node:crypto'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { ProfileAckPurgeRefused } from './contact-sync-profile-ack-purge-schema'
import {
	ackTombstoneIdempotencyKey,
	ackTombstoneKey,
	makeAckTombstone,
	readAckTombstone,
	retainAckTombstone,
} from './contact-sync-ack-tombstone'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import { DROVR_OUTBOX_PURGE_BATCH } from './drovr-outbox'
import {
	ACK_TOMBSTONE_BODY,
	ACK_TOMBSTONE_ENDPOINT,
	ACK_TOMBSTONE_EVENT_TYPE,
	ACK_TOMBSTONE_SOURCE,
	ACK_TOMBSTONE_STATUS,
	type ProfileAckReference,
} from './contact-sync-profile-ack-schema'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'

export type ProfileAckPurgeCandidate = {
	id: string
	target: string
	dedupeKey: string
	heldContinuation?: unknown
}
type Database = typeof import('@/db').db
type Transaction = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>
const sameReference = (a: ProfileAckReference, b: ProfileAckReference) =>
	a.target === b.target &&
	a.contactId === b.contactId &&
	a.profileVersion === b.profileVersion &&
	a.coordinatorKey === b.coordinatorKey &&
	a.requestId === b.requestId &&
	a.request.kind === b.request.kind &&
	(a.request.kind !== 'restate' ||
		(b.request.kind === 'restate' && a.request.period === b.request.period))

/** Composition INSIDE the caller's existing purge transaction. The caller has
 * locked the candidate set and performs exactly one final native DELETE.
 * No ACK reference is excluded/pinned. OFF refuses that entire DELETE instead.
 * Tombstones are written/fenced before deletion and roll back with it.
 */
export async function protectProfileAckPurge(args: {
	transaction: unknown
	candidates: readonly ProfileAckPurgeCandidate[]
	enabled: () => Promise<boolean>
	deleteCandidates: () => Promise<number>
}): Promise<number | ProfileAckPurgeRefused> {
	if (args.candidates.length > DROVR_OUTBOX_PURGE_BATCH)
		throw new ProfileAckConflict(
			'the purge candidate set exceeds its bounded tick budget',
		)
	const references = new Map<string, ProfileAckReference>()
	const candidateRefs = new Map<string, ProfileAckReference>()
	for (const row of args.candidates) {
		const state = readHeldContinuationEnvelope(row.heldContinuation)?.profileAck
		if (!state) continue
		if (state.role === 'tombstone')
			throw new ProfileAckConflict(
				'a control tombstone entered native delivered purge',
			)
		if (state.ref.target !== row.target)
			throw new ProfileAckConflict('purge encountered foreign target metadata')
		if (state.role === 'coordinator' && state.completion) continue
		const identity = `${state.ref.target}:${state.ref.coordinatorKey}`
		const previous = references.get(identity)
		if (previous && !sameReference(previous, state.ref))
			throw new ProfileAckConflict(
				'purge encountered conflicting first request references',
			)
		references.set(identity, state.ref)
		candidateRefs.set(row.id, state.ref)
	}
	if (!references.size) return args.deleteCandidates()
	return writeHeldContinuationGuard(async () => {
		const tx = args.transaction as Transaction
		const incomplete = new Set<string>()
		// Target scoping plus <=128 keys per required-column locking read.
		const targets = [
			...new Set([...references.values()].map((ref) => ref.target)),
		].sort()
		for (const target of targets) {
			const refs = [...references.values()]
				.filter((ref) => ref.target === target)
				.sort((a, b) => a.coordinatorKey.localeCompare(b.coordinatorKey))
			for (let offset = 0; offset < refs.length; offset += 128) {
				const chunk = refs.slice(offset, offset + 128)
				const roots = await tx
					.select({
						key: drovrOutbox.dedupeKey,
						control: drovrOutbox.heldContinuation,
					})
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(
								drovrOutbox.dedupeKey,
								chunk.map((ref) => ref.coordinatorKey),
							),
						),
					)
					.orderBy(asc(drovrOutbox.dedupeKey))
					.for('update')
				for (const ref of chunk) {
					const root = roots.find((row) => row.key === ref.coordinatorKey)
					const state = root
						? readHeldContinuationEnvelope(root.control)?.profileAck
						: undefined
					if (
						state &&
						(state.role !== 'coordinator' || !sameReference(state.ref, ref))
					)
						throw new ProfileAckConflict(
							'purge cannot replace the first scoped coordinator identity',
						)
					if (!state || !state.completion)
						incomplete.add(`${target}:${ref.coordinatorKey}`)
				}
			}
		}
		const protectedRows = [...candidateRefs.values()].filter((ref) =>
			incomplete.has(`${ref.target}:${ref.coordinatorKey}`),
		).length
		if (!protectedRows) return args.deleteCandidates()
		if (!(await profileAckFlagEnabled({ readFlag: args.enabled })))
			return ProfileAckPurgeRefused.make({
				v: 1,
				reason: 'profile-ack-protection-flag-off',
				protectedRows,
				candidateRows: args.candidates.length,
			})
		const response = await tx.execute(sql`SELECT UTC_TIMESTAMP(3) AS at`)
		const outer = response as unknown as unknown[]
		const clockRow = (Array.isArray(outer[0]) ? outer[0][0] : outer[0]) as
			| { at?: string | Date }
			| undefined
		const at = clockRow?.at
		const createdAt =
			at instanceof Date
				? at.toISOString()
				: typeof at === 'string'
					? new Date(`${at.replace(' ', 'T')}Z`).toISOString()
					: undefined
		if (!createdAt)
			throw new ProfileAckConflict('purge has no fresh database UTC clock')
		const clock = createdAt.slice(0, 23).replace('T', ' ')
		// Bounded round trips, not three queries per protected contact. The
		// duplicate branch changes NO clock/body/proof/lifetime column.
		for (const target of targets) {
			const pending = [...references]
				.filter(
					([identity, ref]) =>
						ref.target === target && incomplete.has(identity),
				)
				.map(([, ref]) => ({
					ref,
					key: ackTombstoneKey(ref),
					incoming: makeAckTombstone(ref, {
						createdAt,
						reason: 'expired-evidence',
					}),
				}))
				.sort((a, b) => a.key.localeCompare(b.key))
			for (let offset = 0; offset < pending.length; offset += 128) {
				const chunk = pending.slice(offset, offset + 128)
				await tx
					.insert(drovrOutbox)
					.values(
						chunk.map(({ ref, key, incoming }) => {
							const encoded = encodeHeldContinuationEnvelope({
								v: 1,
								profileAck: incoming,
							})
							return {
								id: randomUUID(),
								dedupeKey: key,
								target: ref.target,
								endpoint: ACK_TOMBSTONE_ENDPOINT,
								tenantId: ref.tenantId,
								contactId: ref.contactId,
								journeyId: ref.journeyId,
								eventType: ACK_TOMBSTONE_EVENT_TYPE,
								idempotencyKey: ackTombstoneIdempotencyKey(ref),
								body: ACK_TOMBSTONE_BODY,
								needsFanOut: false,
								source: ACK_TOMBSTONE_SOURCE,
								status: ACK_TOMBSTONE_STATUS,
								attempts: 0,
								occurredAt: clock,
								firstFailedAt: clock,
								nextAttemptAt: clock,
								createdAt: clock,
								heldContinuation: sql`JSON_EXTRACT(${encoded}, '$')`,
							}
						}),
					)
					.onDuplicateKeyUpdate({
						set: { dedupeKey: sql`${drovrOutbox.dedupeKey}` },
					})
				const saved = await tx
					.select()
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(
								drovrOutbox.dedupeKey,
								chunk.map((item) => item.key),
							),
						),
					)
					.orderBy(asc(drovrOutbox.dedupeKey))
					.for('update')
				const fence: string[] = []
				for (const item of chunk) {
					const row = saved.find((row) => row.dedupeKey === item.key)
					if (!row)
						throw new ProfileAckConflict(
							'purge failed to retain its required tombstone',
						)
					const first = readAckTombstone(row)
					if (retainAckTombstone(first, item.incoming) !== first)
						fence.push(item.key)
				}
				if (fence.length)
					await tx
						.update(drovrOutbox)
						.set({
							heldContinuation: sql`JSON_SET(${drovrOutbox.heldContinuation}, '$.profileAck.evidenceExpired', JSON_EXTRACT('true', '$'))`,
						})
						.where(
							and(
								eq(drovrOutbox.target, target),
								inArray(drovrOutbox.dedupeKey, fence),
							),
						)
			}
		}
		return args.deleteCandidates()
	})
}
