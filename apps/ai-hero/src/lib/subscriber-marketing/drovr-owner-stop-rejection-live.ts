import { and, eq, inArray } from 'drizzle-orm'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { BULK_OUTBOX_QUEUE_WAIT_MS } from './contact-sync-bulk'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import {
	captureDrovrOutboxLive,
	drovrOutboxTargetFromEnv,
} from './drovr-outbox-live'
import {
	buildOwnerStopRejection,
	decideOwnerStopRejection,
	type OwnerStopRejectionInput,
} from './drovr-owner-stop-rejection'

export const OWNER_STOP_REJECTED_DIAGNOSTIC =
	'OwnerStopNeverBorn: you delivered an owner stop, and it failed because drovr proved no actor was born for this owner journey. Accepted: terminal rejection, not delivery. Fix: retain the typed scoped refusal receipt; this owner copy has no remaining debt. Debug: inspect its rejected SDK attempt. Error prose never authorizes gate exclusion.'
const fail = (why: string): never => {
	throw new Error(
		`OwnerStopRejection: you saved a terminal refusal, and it failed because ${why}. Accepted: an atomic rejected status and separately Schema-validated typed receipt in heldContinuation. Fix: retain the gate and inspect the exact scoped attempt; never mark it delivered or fall back to lastError. Debug: inspect the saved SDK and database receipts without exposing bodies.`,
	)
}
const instant = (value: string | Date): string => {
	if (value instanceof Date) return value.toISOString()
	const stamp = Date.parse(
		/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`,
	)
	if (!Number.isFinite(stamp))
		return fail('the retained attempt or original event clock is invalid')
	return new Date(stamp).toISOString()
}

/** No HTTP here. A rolled-back transaction retry never repeats the POST. */
export async function recordOwnerStopRejectionLive(
	input: OwnerStopRejectionInput,
): Promise<'rejected' | 'prior-delivered'> {
	if (input.target !== drovrOutboxTargetFromEnv())
		return fail('the target is not this deployment target')
	const receipt = buildOwnerStopRejection(input)
	const { db } = await import('@/db')
	return writeHeldContinuationGuard(async () => {
		// Probe the dedicated column before any compatibility-sensitive capture.
		// A missing column must refuse the writer, never create legacy prose state.
		await db
			.select({ id: drovrOutbox.id, control: drovrOutbox.heldContinuation })
			.from(drovrOutbox)
			.where(
				and(
					eq(drovrOutbox.target, input.target),
					eq(drovrOutbox.dedupeKey, receipt.scope.key),
					inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
				),
			)
			.limit(1)
		const captured = await captureDrovrOutboxLive([input.entry], undefined, {
			nextAttemptAt: new Date(Date.now() + BULK_OUTBOX_QUEUE_WAIT_MS),
		})
		if (captured.status !== 'outboxed')
			return fail('immutable first-body ownership is unavailable')
		return retryHeldBatchTransaction(() =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, input.target),
							eq(drovrOutbox.dedupeKey, receipt.scope.key),
							inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
						),
					)
					.limit(1)
					.for('update')
				if (!row) return fail('the captured scoped row is absent')
				if (row.status === 'delivered') return 'prior-delivered' as const
				if (!['pending', 'deferred', 'rejected'].includes(row.status))
					return fail(
						'a concurrent held or closed disposition forbids replacing its proof',
					)
				const old = readHeldContinuationEnvelope(row.heldContinuation)
				const encoded = encodeHeldContinuationEnvelope({
					...(old ?? { v: 1 }),
					ownerStopRejection: receipt,
				})
				const state = JSON.parse(encoded)
				const decision = decideOwnerStopRejection({
					...row,
					occurredAt: instant(row.occurredAt),
					status: 'rejected',
					lastStatus: input.httpStatus,
					lastAttemptAt: input.decidedAt,
					heldContinuation: state,
				})
				if (!decision.exclude)
					return fail(`the first-owned row has ${decision.issue}`)
				await tx
					.update(drovrOutbox)
					.set({
						status: 'rejected',
						heldContinuation: state,
						lastStatus: input.httpStatus,
						lastAttemptAt: input.decidedAt.replace('T', ' ').replace('Z', ''),
						lastError: OWNER_STOP_REJECTED_DIAGNOSTIC,
					})
					.where(
						and(
							eq(drovrOutbox.id, row.id),
							eq(drovrOutbox.target, input.target),
							inArray(drovrOutbox.status, ['pending', 'deferred', 'rejected']),
						),
					)
				return 'rejected' as const
			}),
		)
	})
}
