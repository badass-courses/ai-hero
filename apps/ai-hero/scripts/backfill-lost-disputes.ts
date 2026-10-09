/**
 * Apply the lost-chargeback policy to disputes that closed before the
 * automation shipped. Dry-run by default.
 *
 *   pnpm disputes:backfill-lost --input <private.json>            # plan only
 *   pnpm disputes:backfill-lost --input <private.json> --apply    # send + readback
 *
 * The input file is a JSON array of `{ stripeDisputeId, stripeChargeId }`.
 * Keep it outside this repo. Each row is checked against Stripe with
 * `STRIPE_DISPUTE_READ_KEY` (a restricted read key): the dispute must exist,
 * belong to that charge and have status `lost`. `--apply` refuses to run
 * without that confirmation.
 *
 * `--apply` sends the same `commerce/purchase-dispute-closed` event the Stripe
 * webhook sends, so production runs the exact automation code path, then
 * polls the database until the record says `lost` for that dispute, every cut
 * row is still deleted, the buyer outcome is recorded and every Discord role
 * has a result. Output carries ids and statuses only, never emails.
 */
import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { Inngest } from 'inngest'
import Stripe from 'stripe'

import { closeDatabasePool, db } from '../src/db/index'
import { merchantCharge, purchases } from '../src/db/schema'
import { PURCHASE_DISPUTE_CLOSED_EVENT } from '../src/inngest/events/purchase-dispute'
import {
	lostDisputeConfirmed,
	previewDisputeEvent,
	readDisputeState,
} from '../src/lib/purchase-disputes'

type LostDispute = { stripeDisputeId: string; stripeChargeId: string }

function parseArgs(argv: string[]) {
	const input = argv[argv.indexOf('--input') + 1]
	if (!argv.includes('--input') || !input)
		throw new Error('Usage: --input <lost-disputes.json> [--apply]')
	return { input, apply: argv.includes('--apply') }
}

async function readDisputes(path: string): Promise<LostDispute[]> {
	const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every(
			(row) =>
				typeof row?.stripeDisputeId === 'string' &&
				row.stripeDisputeId.startsWith('du_') &&
				typeof row?.stripeChargeId === 'string' &&
				/^(ch|py)_/.test(row.stripeChargeId),
		)
	)
		throw new Error(
			'Input must be a non-empty [{ stripeDisputeId, stripeChargeId }]',
		)
	return parsed
}

/** What Stripe says about the dispute now, or why it could not be checked. */
async function stripeOutcome(stripe: Stripe | null, dispute: LostDispute) {
	if (!stripe) return { checked: false as const, reason: 'no-read-key' }
	const live = await stripe.disputes.retrieve(dispute.stripeDisputeId)
	const charge = typeof live.charge === 'string' ? live.charge : live.charge.id
	const paymentIntent =
		typeof live.payment_intent === 'string'
			? live.payment_intent
			: live.payment_intent?.id
	const chargeMatches = [charge, paymentIntent].includes(dispute.stripeChargeId)
	return {
		checked: true as const,
		status: live.status,
		chargeMatches,
		confirmedLost: live.status === 'lost' && chargeMatches,
	}
}

async function purchaseForCharge(stripeChargeId: string) {
	const [row] = await db
		.select({ purchaseId: purchases.id, status: purchases.status })
		.from(merchantCharge)
		.innerJoin(purchases, eq(purchases.merchantChargeId, merchantCharge.id))
		.where(eq(merchantCharge.identifier, stripeChargeId))
	return row
}

async function plan(stripe: Stripe | null, dispute: LostDispute) {
	const stripeCheck = await stripeOutcome(stripe, dispute)
	const purchase = await purchaseForCharge(dispute.stripeChargeId)
	if (!purchase) return { ...dispute, stripe: stripeCheck, purchase: null }
	const preview = await previewDisputeEvent({
		purchaseId: purchase.purchaseId,
		stripeDisputeId: dispute.stripeDisputeId,
		previousStatus: purchase.status,
		event: 'lost',
	})
	return { ...dispute, stripe: stripeCheck, purchase, preview }
}

async function waitForReadback(
	purchaseId: string,
	stripeDisputeId: string,
	timeoutMs = 180_000,
) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const readback = await readDisputeState(purchaseId)
		const done = lostDisputeConfirmed(readback, stripeDisputeId)
		if (done || Date.now() > deadline) return { done, readback }
		await new Promise((resolve) => setTimeout(resolve, 3_000))
	}
}

async function main() {
	const { input, apply } = parseArgs(process.argv.slice(2))
	const disputes = await readDisputes(input)
	const readKey = process.env.STRIPE_DISPUTE_READ_KEY
	const stripe = readKey ? new Stripe(readKey) : null
	const plans = []
	for (const dispute of disputes) plans.push(await plan(stripe, dispute))
	console.log(
		JSON.stringify({ mode: apply ? 'apply' : 'dry-run', plans }, null, 2),
	)

	const missing = plans.filter((row) => !row.purchase)
	if (missing.length > 0)
		throw new Error(
			`No purchase for ${missing.map((row) => row.stripeChargeId)}`,
		)
	if (!apply) return

	const unconfirmed = plans.filter(
		(row) => !row.stripe.checked || !row.stripe.confirmedLost,
	)
	if (unconfirmed.length > 0)
		throw new Error(
			`Stripe did not confirm a lost dispute for ${unconfirmed.map((row) => row.stripeDisputeId)}`,
		)

	const eventKey = process.env.INNGEST_EVENT_KEY
	if (!eventKey) throw new Error('INNGEST_EVENT_KEY is required for --apply')
	const inngest = new Inngest({ id: 'ai-hero-dispute-backfill', eventKey })

	const readbacks = []
	for (const row of plans) {
		const purchaseId = row.purchase!.purchaseId
		const sent = await inngest.send({
			id: `dispute-closed-backfill-${row.stripeDisputeId}`,
			name: PURCHASE_DISPUTE_CLOSED_EVENT,
			data: {
				stripeChargeId: row.stripeChargeId,
				stripeDisputeId: row.stripeDisputeId,
				purchaseId,
				previousStatus: row.purchase!.status,
				disputeStatus: 'lost',
				outcome: 'lost' as const,
			},
		})
		readbacks.push({
			stripeDisputeId: row.stripeDisputeId,
			purchaseId,
			eventIds: sent.ids,
			...(await waitForReadback(purchaseId, row.stripeDisputeId)),
		})
	}
	console.log(JSON.stringify({ mode: 'apply', readbacks }, null, 2))
	if (readbacks.some((row) => !row.done))
		throw new Error(
			'Readback did not confirm every dispute; check Inngest runs',
		)
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
	.finally(() => closeDatabasePool())
