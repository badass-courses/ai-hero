/**
 * Apply the lost-chargeback policy to disputes that closed before the
 * automation shipped. Dry-run by default.
 *
 *   pnpm disputes:backfill-lost --input <private.json>            # plan only
 *   pnpm disputes:backfill-lost --input <private.json> --apply    # send + readback
 *
 * The input file is a JSON array of `{ stripeDisputeId, stripeChargeId }` for
 * disputes Stripe reports as `lost`. Keep it outside this repo.
 *
 * `--apply` sends the same `commerce/purchase-dispute-closed` event the Stripe
 * webhook sends, so production runs the exact automation code path, then
 * polls the database until the purchase is cut and the buyer is blocked.
 * Output carries ids and statuses only, never emails.
 */
import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { Inngest } from 'inngest'

import { closeDatabasePool, db } from '../src/db/index'
import { merchantCharge, purchases } from '../src/db/schema'
import { PURCHASE_DISPUTE_CLOSED_EVENT } from '../src/inngest/events/purchase-dispute'
import { previewLostDispute } from '../src/lib/purchase-disputes'

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

async function purchaseForCharge(stripeChargeId: string) {
	const [row] = await db
		.select({ purchaseId: purchases.id, status: purchases.status })
		.from(merchantCharge)
		.innerJoin(purchases, eq(purchases.merchantChargeId, merchantCharge.id))
		.where(eq(merchantCharge.identifier, stripeChargeId))
	return row
}

async function plan(dispute: LostDispute) {
	const purchase = await purchaseForCharge(dispute.stripeChargeId)
	if (!purchase) return { ...dispute, purchase: null, preview: null }
	const preview = await previewLostDispute({
		purchaseId: purchase.purchaseId,
		stripeDisputeId: dispute.stripeDisputeId,
		previousStatus: purchase.status,
	})
	return { ...dispute, purchase, preview }
}

async function waitForReadback(
	input: Parameters<typeof previewLostDispute>[0],
	timeoutMs = 120_000,
) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const preview = await previewLostDispute(input)
		// A Refunded or Banned purchase already lost access and records nothing;
		// the block alone proves the event ran.
		const done =
			preview.kind === 'planned' &&
			preview.userAlreadyBlocked &&
			(preview.alreadyRevoked || preview.restoreStatus === null)
		if (done || Date.now() > deadline) return { done, preview }
		await new Promise((resolve) => setTimeout(resolve, 3_000))
	}
}

async function main() {
	const { input, apply } = parseArgs(process.argv.slice(2))
	const disputes = await readDisputes(input)
	const plans = await Promise.all(disputes.map(plan))
	console.log(
		JSON.stringify({ mode: apply ? 'apply' : 'dry-run', plans }, null, 2),
	)

	const missing = plans.filter((row) => !row.purchase)
	if (missing.length > 0)
		throw new Error(
			`No purchase for ${missing.map((row) => row.stripeChargeId)}`,
		)
	if (!apply) return

	const eventKey = process.env.INNGEST_EVENT_KEY
	if (!eventKey) throw new Error('INNGEST_EVENT_KEY is required for --apply')
	const inngest = new Inngest({ id: 'ai-hero-dispute-backfill', eventKey })

	const readbacks = []
	for (const row of plans) {
		const event = {
			stripeChargeId: row.stripeChargeId,
			stripeDisputeId: row.stripeDisputeId,
			purchaseId: row.purchase!.purchaseId,
			previousStatus: row.purchase!.status,
			disputeStatus: 'lost',
			outcome: 'lost' as const,
		}
		const sent = await inngest.send({
			id: `dispute-closed-backfill-${row.stripeDisputeId}`,
			name: PURCHASE_DISPUTE_CLOSED_EVENT,
			data: event,
		})
		const readback = await waitForReadback(event)
		readbacks.push({
			stripeDisputeId: row.stripeDisputeId,
			purchaseId: event.purchaseId,
			eventIds: sent.ids,
			...readback,
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
