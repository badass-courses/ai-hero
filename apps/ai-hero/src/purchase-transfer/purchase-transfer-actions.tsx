'use server'

import process from 'process'
import { emailProvider } from '@/coursebuilder/email-provider'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter, db } from '@/db'
import {
	merchantCharge,
	merchantCustomer,
	purchases as purchaseTable,
	purchaseUserTransfer as purchaseUserTransferTable,
} from '@/db/schema'
import { env } from '@/env.mjs'
import {
	evaluateAccept,
	evaluateCancel,
	evaluateInitiate,
	IN_FLIGHT_TRANSFER_STATES,
	OPEN_TRANSFER_STATES,
	TRANSFER_DENIAL_MESSAGES,
	transferDenialError,
} from '@/purchase-transfer/transfer-lifecycle'
import {
	getUnpublishedTransferOutboxEvents,
	publishTransferOutboxEvent,
	recordTransferOutboxEvent,
} from '@/purchase-transfer/transfer-outbox'
import { authOptions, getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { Theme } from '@auth/core/types'
import { render } from '@react-email/render'
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { Inngest } from 'inngest'
import type { NextAuthConfig } from 'next-auth'
import { v4 } from 'uuid'
import { z } from 'zod'

import { PURCHASE_TRANSFERRED_EVENT } from '@coursebuilder/core/inngest/purchase-transfer/event-purchase-transferred'
import { sendServerEmail } from '@coursebuilder/core/lib/send-server-email'
import { purchaseUserTransferSchema } from '@coursebuilder/core/schemas'
import PurchaseTransferEmail from '@coursebuilder/email-templates/emails/purchase-transfer'

function getRowsAffected(result: unknown): number {
	if (
		result &&
		typeof result === 'object' &&
		'rowsAffected' in result &&
		typeof (result as { rowsAffected: unknown }).rowsAffected === 'number'
	) {
		return (result as { rowsAffected: number }).rowsAffected
	}
	if (Array.isArray(result)) {
		const header = result[0]
		if (
			header &&
			typeof header === 'object' &&
			'affectedRows' in header &&
			typeof (header as { affectedRows: unknown }).affectedRows === 'number'
		) {
			return (header as { affectedRows: number }).affectedRows
		}
	}
	return 0
}

/** Compare-and-swap a transfer to EXPIRED from a known live state. */
async function markTransferExpired(id: string) {
	await db
		.update(purchaseUserTransferTable)
		.set({ transferState: 'EXPIRED' })
		.where(
			and(
				eq(purchaseUserTransferTable.id, id),
				inArray(purchaseUserTransferTable.transferState, [
					'AVAILABLE',
					'INITIATED',
				]),
			),
		)
}

async function sendPurchaseTransferredEvent(params: {
	purchaseId: string
	sourceUserId: string
	targetUserId: string
	purchaseUserTransferId: string
	user: { id: string; email: string }
}) {
	if (!process.env.INNGEST_EVENT_KEY) {
		throw new Error('INNGEST_EVENT_KEY is not configured')
	}
	const inngest = new Inngest({
		id:
			process.env.INNGEST_APP_NAME ||
			process.env.NEXT_PUBLIC_SITE_TITLE ||
			'Purchase Transfer',
		eventKey: process.env.INNGEST_EVENT_KEY,
	})
	await inngest.send({
		name: PURCHASE_TRANSFERRED_EVENT,
		data: {
			purchaseId: params.purchaseId,
			sourceUserId: params.sourceUserId,
			targetUserId: params.targetUserId,
			purchaseUserTransferId: params.purchaseUserTransferId,
		},
		user: params.user,
	})
}

/**
 * Read a transfer by id. The id is an unguessable capability delivered to
 * the target by email; the invite page needs it before the target signs
 * in, so there is deliberately no session requirement here. Mutations all
 * re-check identity server-side.
 */
export async function getPurchaseTransferById(input: { id: string }) {
	return await courseBuilderAdapter.getPurchaseUserTransferById({
		id: input.id,
	})
}

export async function cancelPurchaseTransfer(input: {
	purchaseUserTransferId: string
}) {
	const { session } = await getServerAuthSession()
	const actorUserId = session?.user?.id ?? null

	const purchaseUserTransfer =
		await courseBuilderAdapter.getPurchaseUserTransferById({
			id: input.purchaseUserTransferId,
		})

	const decision = evaluateCancel({
		transfer: purchaseUserTransfer,
		actorUserId,
	})
	if (!decision.ok) throw transferDenialError(decision)

	const transfer = purchaseUserTransfer!

	// Compare-and-swap so a double cancel or a cancel/accept race can only
	// succeed once; the loser sees zero affected rows.
	const cancelResult = await db
		.update(purchaseUserTransferTable)
		.set({
			transferState: 'CANCELED',
			canceledAt: new Date(),
		})
		.where(
			and(
				eq(purchaseUserTransferTable.id, transfer.id),
				eq(purchaseUserTransferTable.transferState, 'INITIATED'),
			),
		)

	if (getRowsAffected(cancelResult) !== 1) {
		throw new Error(TRANSFER_DENIAL_MESSAGES.invalid_state)
	}

	// Recreate an AVAILABLE slot, but never a second open transfer row for
	// the purchase.
	const openTransfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			eq(purchaseUserTransferTable.purchaseId, transfer.purchaseId),
			inArray(purchaseUserTransferTable.transferState, [
				...OPEN_TRANSFER_STATES,
			]),
		),
	})

	if (openTransfers.length > 0) {
		return db.query.purchaseUserTransfer.findFirst({
			where: eq(purchaseUserTransferTable.id, openTransfers[0]!.id),
		})
	}

	const newPutId = `put_${v4()}`
	await db.insert(purchaseUserTransferTable).values({
		id: newPutId,
		purchaseId: transfer.purchaseId,
		transferState: 'AVAILABLE',
		expiresAt: transfer.expiresAt,
		sourceUserId: transfer.sourceUserId,
	})

	return db.query.purchaseUserTransfer.findFirst({
		where: eq(purchaseUserTransferTable.id, newPutId),
	})
}

async function readAcceptResult(transferId: string, purchaseId: string) {
	return {
		newPurchase: await db.query.purchases.findFirst({
			where: eq(purchaseTable.id, purchaseId),
		}),
		completedTransfer: await db.query.purchaseUserTransfer.findFirst({
			where: eq(purchaseUserTransferTable.id, transferId),
		}),
	}
}

/**
 * Publish every unpublished outbox row for a transfer, logging (never
 * throwing) on failure so a committed ownership change is not reported as
 * an error. Safe to call repeatedly.
 */
async function publishTransferOutboxEvents(
	transfer: { id: string; purchaseId: string; sourceUserId: string },
	user: { id: string; email: string },
) {
	const unpublished = await getUnpublishedTransferOutboxEvents(transfer.id)
	for (const row of unpublished) {
		const publishResult = await publishTransferOutboxEvent({
			outboxId: row.id,
			send: () =>
				sendPurchaseTransferredEvent({
					purchaseId: transfer.purchaseId,
					sourceUserId: transfer.sourceUserId,
					targetUserId: user.id,
					purchaseUserTransferId: transfer.id,
					user: { id: user.id, email: user.email },
				}),
		})
		if (!publishResult.published) {
			log.error('purchase_transfer.accept_event_publish_failed', {
				purchaseUserTransferId: transfer.id,
				purchaseId: transfer.purchaseId,
				outboxId: row.id,
				error: publishResult.error,
			})
		}
	}
}

/**
 * Complete a VERIFIED (claimed) transfer. Every step is idempotent, so
 * this converges no matter where a previous attempt stopped: after the
 * claim, after the Stripe write, after the local transaction, or before
 * the event publish. It also heals pre-outbox VERIFIED rows: the upsert
 * creates the missing outbox row from current state and publishes it.
 */
async function completeVerifiedTransfer(
	transfer: { id: string; purchaseId: string; sourceUserId: string },
	user: { id: string; email: string; name?: string | null },
) {
	const purchase = await db.query.purchases.findFirst({
		where: eq(purchaseTable.id, transfer.purchaseId),
		with: {
			merchantCharge: {
				with: {
					merchantCustomer: true,
				},
			},
		},
	})

	if (!purchase) {
		throw new Error('No purchase found')
	}

	// The claim is already ours (VERIFIED), so a concurrent cancel can no
	// longer win: this Stripe write only happens for a transfer that will
	// complete. Same-values idempotent on retry.
	if (purchase?.merchantCharge?.merchantCustomer) {
		const { identifier } = purchase.merchantCharge.merchantCustomer
		const existingCustomer = await stripeProvider.getCustomer(identifier)

		await stripeProvider.updateCustomer(identifier, {
			email: user.email,
			name: user.name || existingCustomer.name || user.email,
		})
	}

	// One transaction: ownership move, merchant row reassignment, and the
	// durable outbox event. All writes are idempotent (absolute values plus
	// an upsert into the per-transfer-event unique key), so a resumed
	// attempt converges instead of duplicating.
	await db.transaction(async (tx) => {
		await tx
			.update(purchaseTable)
			.set({ userId: user.id })
			.where(eq(purchaseTable.id, transfer.purchaseId))

		if (purchase?.merchantCharge?.merchantCustomer) {
			await tx
				.update(merchantCharge)
				.set({ userId: user.id })
				.where(eq(merchantCharge.id, purchase.merchantCharge.id))

			await tx
				.update(merchantCustomer)
				.set({ userId: user.id })
				.where(
					eq(merchantCustomer.id, purchase.merchantCharge.merchantCustomerId),
				)
		}

		await recordTransferOutboxEvent(tx, {
			purchaseUserTransferId: transfer.id,
			purchaseId: transfer.purchaseId,
			sourceUserId: transfer.sourceUserId,
			targetUserId: user.id,
			eventName: PURCHASE_TRANSFERRED_EVENT,
			payload: {
				purchaseId: transfer.purchaseId,
				sourceUserId: transfer.sourceUserId,
				targetUserId: user.id,
				purchaseUserTransferId: transfer.id,
			},
		})
	})

	// Publish after commit. A failure is recorded on the outbox row and
	// logged; the transfer stays VERIFIED (never COMPLETED) until the
	// workflow finishes, so the stall is visible and replayable.
	await publishTransferOutboxEvents(transfer, user)

	return readAcceptResult(transfer.id, transfer.purchaseId)
}

export async function acceptPurchaseTransfer(input: {
	purchaseUserTransferId: string
}) {
	const token = await getServerAuthSession()
	const { getPurchaseUserTransferById, getUserById } = courseBuilderAdapter
	const purchaseUserTransfer = await getPurchaseUserTransferById({
		id: input.purchaseUserTransferId,
	})
	const user = token.session?.user
		? await getUserById(token.session.user.id)
		: null

	if (!user) {
		throw new Error('No user found')
	}

	const decision = evaluateAccept({
		transfer: purchaseUserTransfer,
		actorUserId: user.id,
	})

	if (!decision.ok) {
		if (decision.markExpired && purchaseUserTransfer) {
			await markTransferExpired(purchaseUserTransfer.id)
		}
		throw transferDenialError(decision)
	}

	const transfer = purchaseUserTransfer!

	if (decision.kind === 'replay') {
		// Terminal for this target: succeed without new side effects, but
		// retry any event publish that previously failed.
		await publishTransferOutboxEvents(transfer, user)
		return readAcceptResult(transfer.id, transfer.purchaseId)
	}

	if (decision.kind === 'accept') {
		// Claim first, before any external mutation: compare-and-swap
		// INITIATED -> VERIFIED for this target. A concurrent cancel can only
		// win before this point, when nothing (local or Stripe) has changed.
		const claim = await db
			.update(purchaseUserTransferTable)
			.set({
				transferState: 'VERIFIED',
				confirmedAt: new Date(),
			})
			.where(
				and(
					eq(purchaseUserTransferTable.id, transfer.id),
					eq(purchaseUserTransferTable.transferState, 'INITIATED'),
					eq(purchaseUserTransferTable.targetUserId, user.id),
				),
			)

		if (getRowsAffected(claim) !== 1) {
			// Lost a concurrent race. If this same target already holds the
			// claim, resume it; if the transfer completed, replay; anything
			// else (cancel won, retarget) is a real denial with no side
			// effects — Stripe has not been touched.
			const latest = await getPurchaseUserTransferById({ id: transfer.id })
			const retry = evaluateAccept({ transfer: latest, actorUserId: user.id })
			if (retry.ok && retry.kind === 'resume') {
				return completeVerifiedTransfer(transfer, user)
			}
			if (retry.ok && retry.kind === 'replay') {
				return readAcceptResult(transfer.id, transfer.purchaseId)
			}
			throw new Error(TRANSFER_DENIAL_MESSAGES.invalid_state)
		}
	}

	// Fresh claim and resumed claim share one idempotent completion path,
	// so a crash anywhere in it converges on the next accept.
	return completeVerifiedTransfer(transfer, user)
}

/**
 * Transfers for a purchase, visible only to the authenticated source
 * owner. There is deliberately no caller-supplied user id: the session is
 * the only authority. Guest post-purchase management returns later via a
 * signed purchase capability (see AIH-223).
 */
export async function getPurchaseTransferForPurchaseId(input: { id: string }) {
	const { session } = await getServerAuthSession()
	const ownerId = session?.user?.id

	if (!ownerId) {
		return []
	}

	const transfers = await db.query.purchaseUserTransfer.findMany({
		where: and(
			eq(purchaseUserTransferTable.sourceUserId, ownerId),
			eq(purchaseUserTransferTable.purchaseId, input.id),
			// include rows that never expire (NULL) or ones in the future
			or(
				isNull(purchaseUserTransferTable.expiresAt),
				gte(purchaseUserTransferTable.expiresAt, new Date()),
			),
		),
	})

	return z.array(purchaseUserTransferSchema).parse(transfers)
}

export async function initiatePurchaseTransfer(input: {
	purchaseUserTransferId: string
	email: string
}) {
	const { session } = await getServerAuthSession()
	const actorUserId = session?.user?.id ?? null
	const actorEmail = session?.user?.email ?? null

	const purchaseUserTransfer =
		await courseBuilderAdapter.getPurchaseUserTransferById({
			id: input.purchaseUserTransferId,
		})

	const parsedEmailResult = z.string().email().safeParse(input.email.trim())
	if (!parsedEmailResult.success) {
		throw new Error(TRANSFER_DENIAL_MESSAGES.invalid_email)
	}
	const parsedEmail = parsedEmailResult.data.toLowerCase()

	const inFlight = purchaseUserTransfer
		? await db.query.purchaseUserTransfer.findMany({
				where: and(
					eq(
						purchaseUserTransferTable.purchaseId,
						purchaseUserTransfer.purchaseId,
					),
					inArray(purchaseUserTransferTable.transferState, [
						...IN_FLIGHT_TRANSFER_STATES,
					]),
				),
			})
		: []

	// Authorization and state checks run before any side effect (including
	// target user creation).
	const preDecision = evaluateInitiate({
		transfer: purchaseUserTransfer,
		actorUserId,
		actorEmail,
		targetEmail: parsedEmail,
		inFlightCountForPurchase: inFlight.length,
	})
	if (!preDecision.ok) {
		if (preDecision.markExpired && purchaseUserTransfer) {
			await markTransferExpired(purchaseUserTransfer.id)
		}
		throw transferDenialError(preDecision)
	}

	const transfer = purchaseUserTransfer!

	const { user: toUser } =
		await courseBuilderAdapter.findOrCreateUser(parsedEmail)

	const decision = evaluateInitiate({
		transfer,
		actorUserId,
		targetUserId: toUser.id,
		inFlightCountForPurchase: inFlight.length,
	})
	if (!decision.ok) throw transferDenialError(decision)

	// Compare-and-swap AVAILABLE -> INITIATED; a concurrent initiate on the
	// same slot loses with zero affected rows.
	const initiateResult = await db
		.update(purchaseUserTransferTable)
		.set({
			targetUserId: toUser.id,
			transferState: 'INITIATED',
		})
		.where(
			and(
				eq(purchaseUserTransferTable.id, transfer.id),
				eq(purchaseUserTransferTable.transferState, 'AVAILABLE'),
			),
		)

	if (getRowsAffected(initiateResult) !== 1) {
		throw new Error(TRANSFER_DENIAL_MESSAGES.invalid_state)
	}

	const initiatedTransfer = await db.query.purchaseUserTransfer.findFirst({
		where: eq(purchaseUserTransferTable.id, transfer.id),
	})

	if (!initiatedTransfer) {
		throw new Error('No purchaseUserTransfer found')
	}

	await sendServerEmail({
		email: toUser.email,
		callbackUrl: `${process.env.NEXT_PUBLIC_URL}/transfer/${initiatedTransfer.id}`,
		baseUrl: env.COURSEBUILDER_URL,
		authOptions: authOptions as NextAuthConfig,
		type: 'transfer',
		html: defaultHtml,
		text: defaultText,
		expiresAt: initiatedTransfer.expiresAt,
		adapter: courseBuilderAdapter,
		emailProvider: emailProvider,
	})

	return initiatedTransfer
}

type HTMLEmailParams = Record<'url' | 'host' | 'email', string> & {
	expires?: Date
}

async function defaultHtml(
	{ url, host, email }: HTMLEmailParams,
	theme?: Theme,
) {
	return await render(
		PurchaseTransferEmail(
			{
				url,
				host,
				email,
				siteName:
					process.env.NEXT_PUBLIC_PRODUCT_NAME ||
					process.env.NEXT_PUBLIC_SITE_TITLE ||
					'',
				previewText: 'Claim your seat.',
			},
			theme,
		),
	)
}

// Email Text body (fallback for email clients that don't render HTML, e.g. feature phones)
async function defaultText(
	{ url, host, email }: HTMLEmailParams,
	theme?: Theme,
) {
	return await render(
		PurchaseTransferEmail(
			{
				url,
				host,
				email,
				siteName:
					process.env.NEXT_PUBLIC_PRODUCT_NAME ||
					process.env.NEXT_PUBLIC_SITE_TITLE ||
					'',
				previewText:
					process.env.NEXT_PUBLIC_PRODUCT_NAME ||
					process.env.NEXT_PUBLIC_SITE_TITLE ||
					'login link',
			},
			theme,
		),
		{
			plainText: true,
		},
	)
}
