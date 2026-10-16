import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { BULK_OUTBOX_QUEUE_WAIT_MS } from './contact-sync-bulk'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import {
	freezeProfileAckRequest,
	ProfileAckConflict,
} from './contact-sync-profile-ack'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import {
	lockProfileAckVersion,
	lookupProfileAckReferences,
} from './contact-sync-profile-ack-lookup'
import {
	ACK_TOMBSTONE_MAX_AGE_MS,
	PROFILE_ACK_MAX_REFERENCES,
} from './contact-sync-profile-ack-schema'
import type { ProfileAck } from './contact-sync-profile-ack-schema'
import type {
	LogicalProfileAckRequest,
	ProfileAckPreparation,
	ProfileAckRegistrationInput,
	ProfileAckUnavailableReason,
} from './contact-sync-profile-ack-registration'
import {
	createDrizzleDrovrOutboxStore,
	fromStored,
} from './drovr-outbox-drizzle'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import type { DrovrOutboxRow } from './drovr-outbox'

type Database = typeof import('@/db').db
type Native = typeof drovrOutbox.$inferSelect
const CHUNK = 128
function instant(value: string | Date): string {
	if (value instanceof Date) return value.toISOString()
	const result = new Date(
		/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`,
	)
	if (!Number.isFinite(result.getTime()))
		throw new ProfileAckConflict(
			'the stored authority clock is not a valid UTC instant',
		)
	return result.toISOString()
}
/** Execute in the actual SDK effect. No application clock, session SET,
 * environment override or broker timestamp substitutes for database UTC. */
export async function readProfileAckRegistrationEpoch(
	database: unknown,
): Promise<string> {
	const db = database as Pick<Database, 'execute'>
	const result: unknown = await db.execute(
		sql`SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`,
	)
	const rows: unknown = Array.isArray(result)
		? Array.isArray(result[0])
			? result[0]
			: result
		: result && typeof result === 'object' && 'rows' in result
			? result.rows
			: undefined
	const row = Array.isArray(rows)
		? (rows[0] as { nowUtc?: unknown } | undefined)
		: undefined
	if (typeof row?.nowUtc !== 'string')
		throw new ProfileAckConflict(
			'the registration adapter did not return positive database UTC authority',
		)
	return instant(row.nowUtc)
}
async function lockedRows(
	database: unknown,
	target: string,
	keys: readonly string[],
): Promise<Native[]> {
	const db = database as Pick<Database, 'select'>
	const sorted = [...new Set(keys)].sort()
	const rows: Native[] = []
	for (let offset = 0; offset < sorted.length; offset += CHUNK) {
		rows.push(
			...(await writeHeldContinuationGuard(() =>
				db
					.select()
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, target),
							inArray(
								drovrOutbox.dedupeKey,
								sorted.slice(offset, offset + CHUNK),
							),
						),
					)
					.orderBy(asc(drovrOutbox.dedupeKey))
					.for('update'),
			)),
		)
	}
	return rows
}

/** First capture and coordinator/member registration are one SQL commit.
 * Known metadata is always read before the OFF legacy exit. There is no
 * broker/HTTP callback, ACK writer, receipt pin or post-commit capture here. */
export async function prepareProfileAckRegistration(args: {
	database: unknown
	target: string | undefined
	input: ProfileAckRegistrationInput
	enabled: () => Promise<boolean>
}): Promise<ProfileAckPreparation> {
	const { input } = args
	const logical: LogicalProfileAckRequest = {
		target: args.target,
		contactId: input.contactId,
		profileVersion: input.version.profileVersion,
		request: input.request,
	}
	const unavailable = (
		reason: ProfileAckUnavailableReason,
	): ProfileAckPreparation => ({
		_tag: 'ProfileAckUnavailable',
		logical,
		reason,
	})
	const db = args.database as Pick<Database, 'transaction'>
	if (typeof db?.transaction !== 'function')
		throw new ProfileAckConflict(
			'the first-capture adapter cannot provide a contact-first transaction',
		)
	return retryHeldBatchTransaction(async () => {
		// Fresh per rolled-back attempt; never infer ON from SDK provenance.
		const enabled = await profileAckFlagEnabled({ readFlag: args.enabled })
		if (!args.target) return unavailable('outbox-unconfigured')
		const target = args.target
		return db.transaction(async (tx) => {
			const version = await lockProfileAckVersion(tx, input.contactId)
			const known = await lookupProfileAckReferences({
				database: tx,
				target,
				contactId: input.contactId,
				profileVersion: input.version.profileVersion,
				request: input.request,
				strict: enabled,
			}).catch((error) => {
				// Pre-outbox OFF deployments cannot contain new frozen metadata.
				// Do not turn any other read failure into legacy permission.
				let cause: unknown = error
				for (
					let depth = 0;
					!enabled && depth < 6 && cause && typeof cause === 'object';
					depth++
				) {
					const value = cause as {
						errno?: number
						code?: string
						cause?: unknown
					}
					if (value.errno === 1146 || value.code === 'ER_NO_SUCH_TABLE')
						return []
					cause = value.cause
				}
				throw error
			})
			if (known.length)
				return { _tag: 'ProfileAckKnown' as const, ref: known[0]! }
			// Absence after finite metadata retention is NOT positive proof of
			// never-registration, even OFF. Only a fresh, new-code version effect
			// (or a distinct monthly request) can enter the legacy first road.
			if (input.version.profileAckProtocol !== 1)
				return unavailable('legacy-sdk-unregistered')
			if (
				!version ||
				Number(version.profileVersion) !== input.version.profileVersion ||
				version.profileHash !== input.contentHash ||
				instant(version.updatedAt) !== input.version.since
			)
				return unavailable('version-superseded')
			const acknowledged =
				version.acknowledgedVersion != null &&
				Number(version.acknowledgedVersion) === input.version.profileVersion
			if (input.request.kind === 'delta' && acknowledged)
				return unavailable('already-confirmed-without-retained-request')
			if (input.request.kind === 'delta' && input.version.newlyIssued !== true)
				return unavailable('unchanged-unregistered-version')
			const epoch = input.registrationEpoch
			if (
				!epoch ||
				!Number.isFinite(Date.parse(epoch)) ||
				new Date(epoch).toISOString() !== epoch
			)
				return unavailable('registration-epoch-unavailable')
			const now = await readProfileAckRegistrationEpoch(tx)
			const elapsed = Date.parse(now) - Date.parse(epoch)
			if (elapsed < 0) return unavailable('registration-epoch-unavailable')
			if (elapsed >= ACK_TOMBSTONE_MAX_AGE_MS)
				return unavailable('registration-epoch-expired')
			if (input.request.kind === 'restate') {
				if (!acknowledged || input.request.period !== now.slice(0, 7))
					return unavailable('restatement-period-unavailable')
				if (
					version.acknowledgedAt != null &&
					instant(version.acknowledgedAt).slice(0, 7) === input.request.period
				)
					return unavailable('already-confirmed-without-retained-request')
			}
			if (!enabled) return { _tag: 'ProfileAckDisabled' as const }
			if (
				!input.events.length ||
				input.events.length > PROFILE_ACK_MAX_REFERENCES
			)
				throw new ProfileAckConflict(
					'the first-capture native roster is empty or exceeds its reference budget',
				)
			const candidates: DrovrOutboxRow[] = input.events
				.map((event) => {
					const { firstSentAt: _firstSentAt, ...entry } = outboxEntryForEvent(
						event,
						input.request.kind === 'restate' ? 'bulkRestate' : 'bulkDelta',
					)
					return {
						...entry,
						id: randomUUID(),
						dedupeKey: drovrOutboxDedupeKey(target, entry),
						target,
						status: 'pending' as const,
						attempts: 0,
						lastStatus: null,
						lastError: 'contact sync queued for paced delivery',
						firstFailedAt: epoch,
						nextAttemptAt: new Date(
							Date.parse(now) + BULK_OUTBOX_QUEUE_WAIT_MS,
						).toISOString(),
						lastAttemptAt: null,
						deliveredAt: null,
						releasedAt: null,
						createdAt: now,
					}
				})
				.sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey))
			const proposed = freezeProfileAckRequest({
				target,
				contactId: input.contactId,
				profileVersion: input.version.profileVersion,
				registeredAt: now,
				rows: candidates,
			})
			if (!isDeepStrictEqual(proposed.ref.request, input.request))
				throw new ProfileAckConflict(
					'the declared request kind/period differs from the original profile key',
				)
			const profile = candidates.find(
				(row) => row.dedupeKey === proposed.ref.coordinatorKey,
			)!
			if (
				input.request.kind === 'delta' &&
				profile.occurredAt !== input.version.since
			)
				throw new ProfileAckConflict(
					'the first delta profile clock differs from its locked version authority',
				)
			const keys = candidates.map((row) => row.dedupeKey)
			// Never fill gaps or retrofit a legacy first capture after publication.
			if ((await lockedRows(tx, target, keys)).length)
				return unavailable('ambiguous-legacy-ownership')
			await createDrizzleDrovrOutboxStore(tx).insertIgnore(candidates)
			const saved = await lockedRows(tx, target, keys)
			const ids = new Map(candidates.map((row) => [row.dedupeKey, row.id]))
			if (
				saved.length !== keys.length ||
				saved.some((row) => row.id !== ids.get(row.dedupeKey))
			)
				throw new ProfileAckConflict(
					'a concurrent legacy capture owns original native bytes; the entire new capture must roll back',
				)
			const frozen = freezeProfileAckRequest({
				target,
				contactId: input.contactId,
				profileVersion: input.version.profileVersion,
				registeredAt: now,
				rows: saved.map(fromStored),
			})
			const expected = new Map<string, ProfileAck>()
			const groups = new Map<string, string[]>()
			for (const row of saved) {
				const before = readHeldContinuationEnvelope(row.heldContinuation)
				if (before?.profileAck)
					throw new ProfileAckConflict(
						'first-capture ownership changed before metadata publication',
					)
				const ack: ProfileAck =
					row.dedupeKey === frozen.ref.coordinatorKey
						? frozen
						: { v: 1, role: 'member', ref: frozen.ref }
				expected.set(row.dedupeKey, ack)
				const encoded = encodeHeldContinuationEnvelope({
					...(before ?? { v: 1 }),
					profileAck: ack,
				})
				const group = groups.get(encoded) ?? []
				group.push(row.dedupeKey)
				groups.set(encoded, group)
			}
			for (const [encoded, group] of groups)
				for (let offset = 0; offset < group.length; offset += CHUNK) {
					await writeHeldContinuationGuard(() =>
						tx
							.update(drovrOutbox)
							.set({ heldContinuation: sql`JSON_EXTRACT(${encoded}, '$')` })
							.where(
								and(
									eq(drovrOutbox.target, target),
									inArray(
										drovrOutbox.dedupeKey,
										group.slice(offset, offset + CHUNK),
									),
								),
							),
					)
				}
			// Verify ALL committed-to-be pointers before returning the immutable
			// SDK reference. Every 128-row read still requires the actual column.
			const installed = await lockedRows(tx, target, keys)
			if (
				installed.length !== keys.length ||
				installed.some(
					(row) =>
						!isDeepStrictEqual(
							readHeldContinuationEnvelope(row.heldContinuation)?.profileAck,
							expected.get(row.dedupeKey),
						),
				)
			)
				throw new ProfileAckConflict(
					'the frozen coordinator/member metadata was not installed for the whole native capture',
				)
			return { _tag: 'ProfileAckCaptured' as const, ref: frozen.ref }
		})
	})
}
