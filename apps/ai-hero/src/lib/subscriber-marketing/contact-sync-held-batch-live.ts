import { randomUUID } from 'node:crypto'
import type { DrovrContactSyncRetryRequested } from '@/inngest/events/drovr'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import {
	decodeHeldBatchContinuation,
	HeldBatchContinuationError,
} from './contact-sync-held-batch'
import {
	heldBatchPersistenceLive,
	heldBatchRowsLive,
} from './contact-sync-held-batch-drizzle'
import { planHeldBatchRelease } from './contact-sync-held-batch-release'
import { readOutboxQueueState } from './drovr-outbox-queue-state'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import { readWithHeldContinuationFallback } from './drovr-outbox-control'
import { heldBatchPinState } from './contact-sync-held-batch-pins'
import { parkHeldBatchContinuation } from './contact-sync-held-batch-persistence'
import {
	isUncappedOfferRetry,
	retryDeliverySource,
	retryPaceClass,
	routeContactSyncRetry,
} from './contact-sync-retry-route'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import { drovrOutboxTargetFromEnv } from './drovr-outbox-live'

type RetryData = DrovrContactSyncRetryRequested['data']

/** Fresh permission check at entry, actual POST and before logical ACK.
 * A stale/completed release is never permission to requeue or re-hold newer work. */
export async function releasedRetryPermissionLive(
	data: RetryData,
): Promise<boolean> {
	if (!data.heldBatchRelease) return true
	const target = drovrOutboxTargetFromEnv()
	if (!target)
		throw new HeldBatchContinuationError({
			reason: 'the released coordinator target is unavailable',
		})
	const row = (
		await heldBatchRowsLive(target, [data.heldBatchRelease.anchorKey])
	)[0]
	if (
		!row ||
		row.queueMetadataInvalid ||
		row.status === 'held' ||
		row.heldBatchBlocked ||
		typeof row.heldBatch !== 'string'
	)
		return false
	const root = decodeHeldBatchContinuation(row.heldBatch)
	const live = isUncappedOfferRetry(data)
	const keys = data.ownedKeys ?? []
	return (
		root.target === target &&
		root.anchorKey === row.dedupeKey &&
		root.completion.state === 'unfinished' &&
		root.release.state === 'released' &&
		root.release.id === data.heldBatchRelease.id &&
		root.originalClock === data.firstFailedAt &&
		root.class === (live ? 'live' : retryPaceClass(data)) &&
		root.source === (live ? 'live' : retryDeliverySource(data)) &&
		root.acknowledge?.contactId === data.acknowledge?.contactId &&
		root.acknowledge?.profileVersion === data.acknowledge?.profileVersion &&
		keys.length === root.members.length &&
		new Set(keys).size === keys.length &&
		root.members.every((member) => keys.includes(member.key))
	)
}

export const HELD_BATCH_DIAGNOSTIC_MAX_ROWS = 50

/** Operator-only bounded read; no body payloads, publication or state writes. */
export async function inspectHeldBatchesLive(
	args: { key?: string; limit?: number; includeEncoded?: boolean } = {},
) {
	const target = drovrOutboxTargetFromEnv()
	const limit = args.limit ?? 10
	if (
		!target ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > HELD_BATCH_DIAGNOSTIC_MAX_ROWS ||
		(args.key !== undefined && !/^[a-f0-9]{64}$/.test(args.key))
	)
		throw new HeldBatchContinuationError({
			reason:
				'a configured target, full scoped key and bounded diagnostic limit are required',
		})
	const [{ db }, { drovrOutbox }, { and, eq, asc, sql, inArray }] =
		await Promise.all([
			import('@/db'),
			import('@/db/drovr-outbox-schema'),
			import('drizzle-orm'),
		])
	const present = sql`JSON_CONTAINS_PATH(${drovrOutbox.heldContinuation}, 'one', '$.continuation')`
	const priority = sql`CASE WHEN ${drovrOutbox.status} = 'held' OR JSON_UNQUOTE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.continuation.blocked')) = BINARY 'true' THEN 0 ELSE 1 END`
	const rows = await readWithHeldContinuationFallback(
		() =>
			db
				.select({
					key: drovrOutbox.dedupeKey,
					status: drovrOutbox.status,
					lastError: drovrOutbox.lastError,
					heldContinuation: drovrOutbox.heldContinuation,
				})
				.from(drovrOutbox)
				.where(
					and(
						eq(drovrOutbox.target, target),
						inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
						args.key ? eq(drovrOutbox.dedupeKey, args.key) : present,
					),
				)
				.orderBy(priority, asc(drovrOutbox.id))
				.limit(limit + 1),
		async () => [],
	)
	return {
		more: rows.length > limit,
		entries: rows.slice(0, limit).map((row) => {
			const queue = readOutboxQueueState(row.heldContinuation, row.lastError)
			try {
				if (queue.invalid || typeof queue.heldBatch !== 'string')
					throw new HeldBatchContinuationError({
						reason:
							'the retained diagnostic or encoded continuation is invalid; inspect it without releasing',
					})
				const root = decodeHeldBatchContinuation(queue.heldBatch)
				if (root.target !== target || root.anchorKey !== row.key)
					throw new HeldBatchContinuationError({
						reason:
							'the diagnostic continuation belongs to another scoped anchor',
					})
				return {
					key: row.key,
					nativeStatus: row.status,
					state:
						heldBatchPinState(root, Date.now()) !== 'active'
							? heldBatchPinState(root, Date.now())
							: queue.heldBatchBlocked ||
								  row.status === 'held' ||
								  root.release.state === 'held'
								? 'held'
								: 'released',
					source: root.source,
					class: root.class,
					members: root.members.length,
					originalClock: root.originalClock,
					parkedAt: root.parkedAt,
					queueHandoffs: queue.handoffs,
					publicationId: queue.publicationId,
					reason: queue.heldBatchReason,
					...(args.includeEncoded ? { encoded: queue.heldBatch } : {}),
				}
			} catch (error) {
				return {
					key: row.key,
					nativeStatus: row.status,
					state: 'invalid',
					detail:
						error instanceof HeldBatchContinuationError
							? error.message
							: new HeldBatchContinuationError({
									reason: 'the stored continuation could not be inspected',
								}).message,
				}
			}
		}),
	}
}

/** Explicit release ONLY. Pending-wire anchors become eligible for the normal
 * replay tick. Closed native history stays closed: use the returned request
 * for a deliberate broker publication after checking prior SDK receipts.
 * This function itself never publishes or calls drovr. */
export async function releaseHeldBatchLive(args: {
	key: string
	expectedEncoded: string
	confirmation: string
}) {
	const target = drovrOutboxTargetFromEnv()
	if (!target)
		throw new HeldBatchContinuationError({
			reason: 'the retained target is unavailable',
		})
	const row = (await heldBatchRowsLive(target, [args.key]))[0]
	if (!row)
		throw new HeldBatchContinuationError({
			reason: 'the inspected anchor no longer exists',
		})
	const plan = await planHeldBatchRelease({
		row,
		expectedEncoded: args.expectedEncoded,
		confirmation: args.confirmation,
		releaseId: randomUUID(),
		rows: heldBatchRowsLive,
	})
	const store = await heldBatchPersistenceLive()
	if (
		!(await store.release({
			anchor: { target, key: args.key },
			previous: args.expectedEncoded,
			encoded: plan.encoded,
			now: new Date().toISOString(),
		}))
	)
		throw new HeldBatchContinuationError({
			reason:
				'the inspected permission changed before release; newer state was not overwritten',
		})
	const fresh = (await heldBatchRowsLive(target, [args.key]))[0]
	if (!fresh)
		throw new HeldBatchContinuationError({
			reason:
				'the released permission cannot be observed; inspect retained state before any publication',
		})
	return {
		status: 'released' as const,
		pinState: plan.pinState,
		publication:
			fresh?.queuePublicationId || (fresh?.queueHandoffs ?? 0) > 0
				? ('inspect-existing-sdk' as const)
				: fresh && ['pending', 'held', 'deferred'].includes(fresh.status)
					? ('normal-replay-tick' as const)
					: ('manual-closed-coordinator' as const),
		request: routeContactSyncRetry({ ...plan.request, ts: Date.now() }),
	}
}

export async function completeContactSyncHeldBatchLive(data: RetryData) {
	if (!data.heldBatchRelease) return
	const target = drovrOutboxTargetFromEnv()
	if (!target)
		throw new HeldBatchContinuationError({
			reason: 'the completion target is unavailable; evidence remains pinned',
		})
	const { completeHeldBatch } =
		await import('./contact-sync-held-batch-completion')
	return completeHeldBatch({
		anchor: { target, key: data.heldBatchRelease.anchorKey },
		releaseId: data.heldBatchRelease.id,
		at: new Date().toISOString(),
		store: await heldBatchPersistenceLive(),
		rows: heldBatchRowsLive,
	})
}

export async function abandonHeldBatchLive(args: {
	key: string
	expectedEncoded: string
	confirmation: string
}) {
	const target = drovrOutboxTargetFromEnv()
	if (!target)
		throw new HeldBatchContinuationError({
			reason: 'the abandonment target is unavailable',
		})
	const { abandonHeldBatch } =
		await import('./contact-sync-held-batch-completion')
	return abandonHeldBatch({
		...args,
		anchor: { target, key: args.key },
		at: new Date().toISOString(),
		store: await heldBatchPersistenceLive(),
	})
}

/** No bodies or new clocks: only first-owned scoped keys survive the hold. */
export async function parkContactSyncRetryLive(args: {
	anchor: DrovrShadowEvent
	data: RetryData
	reason: 'outboxed' | 'unproven-delivery'
}): Promise<void> {
	const target = drovrOutboxTargetFromEnv()
	if (!target)
		throw new HeldBatchContinuationError({
			reason:
				'the retained target is unavailable; no continuation was published or acknowledged',
		})
	const keyFor = (event: DrovrShadowEvent) =>
		drovrOutboxDedupeKey(target, outboxEntryForEvent(event, 'contactSync'))
	// The original coordinator survives even after its own wire fact closes.
	const anchor = {
		target,
		key: args.data.heldBatchRelease?.anchorKey ?? keyFor(args.anchor),
	}
	const store = await heldBatchPersistenceLive()
	const reason = new HeldBatchContinuationError({
		reason:
			args.reason === 'outboxed'
				? 'the logical batch contains owed work without receiver acceptance'
				: 'the logical batch contains held or unproven retained work',
	}).message
	// Build after blocking too: malformed input must not bypass the hold.
	const permission = args.data.heldBatchRelease
		? { releaseId: args.data.heldBatchRelease.id }
		: undefined
	if (!(await store.block(anchor, reason, permission)))
		throw new HeldBatchContinuationError({
			reason:
				'the unfinished coordinator anchor could not be held; delivery history was not rewritten',
		})
	const prior = await store.read(anchor)
	const parkedAt =
		typeof prior?.encoded === 'string'
			? decodeHeldBatchContinuation(prior.encoded).parkedAt
			: new Date().toISOString()
	const current = new Map(
		args.data.items.map((item) => [keyFor(item.event), item.reason]),
	)
	const carry = new Map(
		(args.data.carry ?? []).map((item) => [keyFor(item.event), item.reason]),
	)
	const live = isUncappedOfferRetry(args.data)
	await parkHeldBatchContinuation({
		anchor,
		store,
		reason,
		releaseId:
			args.data.heldBatchRelease?.anchorKey === anchor.key
				? args.data.heldBatchRelease.id
				: undefined,
		value: {
			v: 1,
			release: { state: 'held' },
			target,
			anchorKey: anchor.key,
			source: live ? 'live' : retryDeliverySource(args.data),
			class: live ? 'live' : retryPaceClass(args.data),
			originalClock: args.data.firstFailedAt ?? '',
			parkedAt,
			completion: { state: 'unfinished' },
			attempt: args.data.attempt,
			rejectedCarry: args.data.rejectedCarry ?? 0,
			...(args.data.acknowledge ? { acknowledge: args.data.acknowledge } : {}),
			members: (args.data.ownedKeys ?? []).map((key) =>
				current.has(key)
					? { key, phase: 'pending', reason: current.get(key) }
					: carry.has(key)
						? { key, phase: 'carry', reason: carry.get(key) }
						: { key, phase: 'retained' },
			),
		},
	})
}
