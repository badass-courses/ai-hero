import { and, eq, inArray } from 'drizzle-orm'
import { DROVR_OUTBOX_WIRE_STATUSES } from './drovr-outbox-wire-status'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import {
	buildUnsubscribeSupersession,
	readUnsubscribeSupersession,
	supersessionInstant,
	unsubscribeSupersessionDiagnostic,
} from './drovr-unsubscribe-supersession-proof'

const fail = (why: string): never => {
	throw new Error(
		`UnsubscribeClosure: you saved local suppression history, and it failed because ${why}. Accepted: a full-scope typed proof and immutable first body under a locked row. Fix: retain the gate and inspect the source; never parse lastError or change wire clocks or HTTP history. Debug: inspect the retained row and source-cited resubscribe boundary.`,
	)
}

/** Metadata/local disposition only. Never performs HTTP, mutates a body or
 * clock, manufactures acceptance, or overwrites a newer operator permission. */
export async function persistUnsubscribeSupersession(
	database: unknown,
	input: {
		target: string
		key: string
		contactId: string
		resubscribedAt: string
		expectedHeldEncoded?: string
	},
) {
	const db = database as typeof import('@/db').db
	return writeHeldContinuationGuard(() =>
		retryHeldBatchTransaction(() =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, input.target),
							eq(drovrOutbox.dedupeKey, input.key),
							inArray(drovrOutbox.status, [...DROVR_OUTBOX_WIRE_STATUSES]),
						),
					)
					.limit(1)
					.for('update')
				if (!row || row.contactId !== input.contactId)
					return fail(
						'the scoped row is absent or belongs to a different contact',
					)
				if (
					![
						'pending',
						'deferred',
						'held',
						'rejected',
						'superseded',
						'delivered',
					].includes(row.status)
				)
					return fail('the current disposition is unsupported')
				const state = readHeldContinuationEnvelope(row.heldContinuation)
				const prior = readUnsubscribeSupersession(row)
				if (state?.unsubscribeSupersession && !prior.proved)
					return fail(`the retained proof has ${prior.issue}`)
				const incoming = supersessionInstant(input.resubscribedAt)
				if (!incoming) return fail('the source resubscribe instant is invalid')
				const at =
					prior.proved && prior.proof.source.occurredAt >= incoming
						? prior.proof.source.occurredAt
						: incoming
				const proof =
					prior.proved && at === prior.proof.source.occurredAt
						? prior.proof
						: buildUnsubscribeSupersession(row, at, new Date().toISOString())
				const continuation = state?.continuation
				const block =
					row.status === 'held' &&
					input.expectedHeldEncoded !== undefined &&
					continuation?.encoded === input.expectedHeldEncoded
				const next = {
					...(state ?? { v: 1 as const }),
					unsubscribeSupersession: proof,
					...(block
						? {
								continuation: {
									...continuation!,
									blocked: true,
									reason: unsubscribeSupersessionDiagnostic(at),
								},
							}
						: {}),
				}
				const encoded = encodeHeldContinuationEnvelope(next)
				const heldContinuation = JSON.parse(encoded)
				const status = row.status === 'delivered' ? 'delivered' : 'superseded'
				// A delivered carrier keeps its actual status and HTTP diagnostics.
				// No local closure writes lastAttemptAt, lastStatus or deliveredAt.
				await tx
					.update(drovrOutbox)
					.set({
						heldContinuation,
						...(row.status === 'delivered'
							? {}
							: { status, lastError: unsubscribeSupersessionDiagnostic(at) }),
					})
					.where(
						and(
							eq(drovrOutbox.target, input.target),
							eq(drovrOutbox.id, row.id),
							eq(drovrOutbox.status, row.status),
						),
					)
				return { ...row, heldContinuation, status }
			}),
		),
	)
}
