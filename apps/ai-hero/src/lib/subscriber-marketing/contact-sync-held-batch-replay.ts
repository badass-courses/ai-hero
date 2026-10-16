import {
	CONTACT_SYNC_RETRY_EVENT,
	type DrovrContactSyncRetryRequested,
} from '@/inngest/events/drovr'
import {
	decodeHeldBatchContinuation,
	HeldBatchContinuationError,
} from './contact-sync-held-batch'
import type { HeldBatchAnchor } from './contact-sync-held-batch-persistence'
import {
	drovrOutboxDedupeKey,
	isDrovrOutboxStatus,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type { DeferredDrovrEvent } from './drovr-shadow-delivery'
import {
	supersededUnsubscribeAt,
	supersedingResubscribeAt,
} from './drovr-unsubscribe-supersession'

type RetryRequest = {
	name: typeof CONTACT_SYNC_RETRY_EVENT
	id: string
	data: DrovrContactSyncRetryRequested['data']
}
export type HeldBatchReplayPlan =
	| { kind: 'held'; reason: string }
	| { kind: 'retry'; request: RetryRequest }
export type HeldBatchReplayPorts = {
	block: (
		anchor: HeldBatchAnchor,
		reason: string,
		expected: { encoded: unknown },
	) => Promise<boolean>
	rows: (
		target: string,
		keys: readonly string[],
	) => Promise<readonly DrovrOutboxRow[]>
}

/**
 * Read-only reconstruction from FIRST stored bodies. Metadata phases describe
 * a slice, never receiver acceptance. Any invalid proof blocks the anchor and
 * throws a literal-prompt error; held work never receives a publish command.
 */
export async function prepareHeldBatchReplay(
	anchor: DrovrOutboxRow,
	ports: HeldBatchReplayPorts,
): Promise<HeldBatchReplayPlan | undefined> {
	if (!('heldBatch' in anchor) && !anchor.heldBatchBlocked) return undefined
	const scope = { target: anchor.target, key: anchor.dedupeKey }
	const fail = (reason: string) => new HeldBatchContinuationError({ reason })
	try {
		if (typeof anchor.heldBatch !== 'string')
			throw fail(
				'the held anchor has no encoded v1 continuation; its diagnostic was retained',
			)
		const continuation = decodeHeldBatchContinuation(anchor.heldBatch)
		if (
			continuation.target !== scope.target ||
			continuation.anchorKey !== scope.key ||
			anchor.queueMetadataInvalid
		)
			throw fail(
				'the continuation target, anchor or diagnostic envelope does not match its retained scope',
			)
		if (continuation.completion.state === 'completed')
			return {
				kind: 'held',
				reason: 'the logical coordinator is completed; no replay is authorized',
			}
		if (anchor.heldBatchBlocked || continuation.release.state === 'held') {
			const reason =
				anchor.heldBatchReason ?? 'explicit operator release is required'
			if (!(await ports.block(scope, reason, { encoded: anchor.heldBatch })))
				throw fail(
					'the held snapshot changed; a newer release or delivery was not overwritten',
				)
			return { kind: 'held', reason }
		}
		const keys = continuation.members.map((member) => member.key)
		const rows = await ports.rows(continuation.target, keys)
		if (
			rows.length !== keys.length ||
			new Set(rows.map((row) => row.dedupeKey)).size !== keys.length
		)
			throw fail(
				'one or more full scoped member rows are missing or duplicated',
			)
		const byKey = new Map(rows.map((row) => [row.dedupeKey, row]))
		const items: DeferredDrovrEvent[] = []
		const carry: DeferredDrovrEvent[] = []
		let priorRejected = 0
		for (const reference of continuation.members) {
			const row = byKey.get(reference.key)
			if (
				!row ||
				row.target !== continuation.target ||
				row.endpoint !== 'events' ||
				row.dedupeKey !== drovrOutboxDedupeKey(row.target, row) ||
				!isDrovrOutboxStatus(row.status) ||
				row.needsFanOut ||
				row.queueMetadataInvalid
			)
				throw fail(
					'a retained member is not a normalized event in the approved full scope',
				)
			const event = row.body
			if (
				!event ||
				typeof event !== 'object' ||
				!('type' in event) ||
				event.tenantId !== row.tenantId ||
				event.contactId !== row.contactId ||
				event.journeyId !== row.journeyId ||
				event.idempotencyKey !== row.idempotencyKey ||
				event.type !== row.eventType ||
				!Number.isFinite(Date.parse(row.firstFailedAt))
			)
				throw fail(
					'a retained body or original per-member clock does not match its scoped row',
				)
			if (row.status === 'superseded') {
				const lift = supersededUnsubscribeAt(row)
				if (
					event.type !== 'contact.unsubscribed' ||
					!lift ||
					!supersedingResubscribeAt(row, lift)
				)
					throw fail(
						'a retained local unsubscribe closure lacks its strictly newer source proof',
					)
			}
			if (
				continuation.acknowledge &&
				[
					'contact.profile.updated',
					'contact.links.issued',
					'contact.offer.issued',
				].includes(event.type)
			) {
				const ack = continuation.acknowledge
				if (
					event.tenantId !== 'org-aihero' ||
					event.contactId !== ack.contactId ||
					!event.payload ||
					!('profileVersion' in event.payload) ||
					event.payload.profileVersion !== ack.profileVersion
				)
					throw fail(
						'the acknowledgement does not match the first stored authority contact/version',
					)
			}
			if (row.heldBatchBlocked || row.status === 'held')
				throw fail(
					'a referenced member still requires explicit operator release',
				)
			if (
				continuation.class === 'live' &&
				event.type !== 'contact.offer.issued'
			)
				throw fail(
					'live offer permission cannot authorize a profile, link, birth or other native member',
				)
			if (reference.phase === 'retained') {
				if (
					row.status !== 'delivered' &&
					row.status !== 'superseded' &&
					row.status !== 'rejected'
				)
					throw fail(
						'an earlier slice lacks a completed durable outcome; metadata cannot stand for acceptance',
					)
				if (row.status === 'rejected') priorRejected += 1
				continue
			}
			const item: DeferredDrovrEvent = { event, reason: reference.reason }
			if (reference.phase === 'carry') carry.push(item)
			else items.push(item)
		}
		if (priorRejected > continuation.rejectedCarry)
			throw fail(
				'retained rejection proof exceeds its original carried rejection count',
			)
		return {
			kind: 'retry',
			request: {
				name: CONTACT_SYNC_RETRY_EVENT,
				id: `held-batch:${continuation.anchorKey}:${continuation.release.id}`,
				data: {
					items,
					attempt: continuation.attempt,
					firstFailedAt: continuation.originalClock,
					ownedKeys: keys,
					rejectedCarry: continuation.rejectedCarry,
					heldBatchRelease: {
						anchorKey: continuation.anchorKey,
						id: continuation.release.id,
					},
					...(continuation.source !== 'live'
						? { deliverySource: continuation.source }
						: {}),
					...(continuation.class !== 'live'
						? { paceClass: continuation.class }
						: {}),
					...(carry.length ? { carry } : {}),
					...(continuation.acknowledge
						? { acknowledge: { ...continuation.acknowledge } }
						: {}),
				},
			},
		}
	} catch (error) {
		const reported =
			error instanceof HeldBatchContinuationError
				? error
				: fail('the first-owned member rows could not be verified')
		if (
			!(await ports.block(scope, reported.message, {
				encoded: anchor.heldBatch,
			}))
		)
			throw fail(
				'the invalid snapshot could not claim its unchanged anchor; newer state was not rewritten or acknowledged',
			)
		throw reported
	}
}
