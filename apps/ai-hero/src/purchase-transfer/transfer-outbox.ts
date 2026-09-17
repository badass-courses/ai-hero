/**
 * Durable outbox for purchase-transfer events (AIH-223).
 *
 * The accept path writes an outbox row in the same transaction that moves
 * purchase ownership, then publishes after commit. A failed publish marks
 * the row FAILED with the error instead of losing the event, so support
 * and recovery tooling can see and replay stalled transfers.
 */
import { db } from '@/db'
import { purchaseTransferOutbox } from '@/db/schema'
import { log } from '@/server/logger'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { v4 } from 'uuid'

export interface TransferOutboxEventInput {
	id?: string
	purchaseUserTransferId: string
	purchaseId: string
	sourceUserId: string
	targetUserId: string
	eventName: string
	payload: Record<string, unknown>
}

type OutboxExecutor = {
	insert: (typeof db)['insert']
}

/**
 * Insert a PENDING outbox row. Call inside the same transaction as the
 * ownership change so a committed transfer always has a durable event.
 *
 * Idempotent: (purchaseUserTransferId, eventName) is unique, and a
 * duplicate insert is a no-op, so a resumed accept can never create a
 * second row for the same transfer event.
 */
export async function recordTransferOutboxEvent(
	executor: OutboxExecutor,
	input: TransferOutboxEventInput,
): Promise<string> {
	const id = input.id ?? `pto_${v4()}`
	await executor
		.insert(purchaseTransferOutbox)
		.values({
			id,
			purchaseUserTransferId: input.purchaseUserTransferId,
			purchaseId: input.purchaseId,
			sourceUserId: input.sourceUserId,
			targetUserId: input.targetUserId,
			eventName: input.eventName,
			payload: input.payload,
			status: 'PENDING',
		})
		.onDuplicateKeyUpdate({ set: { id: sql`${purchaseTransferOutbox.id}` } })
	return id
}

export interface PublishOutboxResult {
	published: boolean
	error?: string
}

/**
 * Attempt to publish one outbox row. Never throws: a publish failure is
 * recorded on the row (status FAILED + lastError) and returned to the
 * caller, because the local ownership change is already committed and
 * must not be rolled back or hidden by a transport error.
 */
export async function publishTransferOutboxEvent(params: {
	outboxId: string
	send: () => Promise<unknown>
}): Promise<PublishOutboxResult> {
	try {
		await params.send()
		await db
			.update(purchaseTransferOutbox)
			.set({
				status: 'PUBLISHED',
				publishedAt: new Date(),
				attempts: sql`${purchaseTransferOutbox.attempts} + 1`,
				lastError: null,
			})
			.where(eq(purchaseTransferOutbox.id, params.outboxId))
		return { published: true }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log.error('purchase_transfer.outbox_publish_failed', {
			outboxId: params.outboxId,
			error: message,
		})
		try {
			await db
				.update(purchaseTransferOutbox)
				.set({
					status: 'FAILED',
					attempts: sql`${purchaseTransferOutbox.attempts} + 1`,
					lastError: message.slice(0, 5000),
				})
				.where(eq(purchaseTransferOutbox.id, params.outboxId))
		} catch (recordError) {
			// The ownership change is already committed; never surface a
			// bookkeeping failure as an action error. The row stays PENDING,
			// which the recovery query treats as unpublished, so nothing is
			// lost — only the lastError annotation.
			log.error('purchase_transfer.outbox_failure_record_failed', {
				outboxId: params.outboxId,
				publishError: message,
				recordError:
					recordError instanceof Error
						? recordError.message
						: String(recordError),
			})
		}
		return { published: false, error: message }
	}
}

/**
 * Unpublished (PENDING or FAILED) outbox rows for a transfer. Used by the
 * idempotent accept replay path and by recovery tooling.
 */
export async function getUnpublishedTransferOutboxEvents(
	purchaseUserTransferId?: string,
) {
	return db.query.purchaseTransferOutbox.findMany({
		where: purchaseUserTransferId
			? and(
					eq(
						purchaseTransferOutbox.purchaseUserTransferId,
						purchaseUserTransferId,
					),
					inArray(purchaseTransferOutbox.status, ['PENDING', 'FAILED']),
				)
			: inArray(purchaseTransferOutbox.status, ['PENDING', 'FAILED']),
	})
}
