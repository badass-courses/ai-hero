import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Stripe from 'stripe'

import { buildCheckoutCompletedEventData } from '@/lib/checkout-reconcile/checkout-event'
import type { DirectCheckoutFulfillmentResult } from '@/lib/checkout-reconcile/fulfill'
import type { CheckoutFulfillmentState } from '@/lib/checkout-reconcile/inspect'
import { checkoutChargeState } from '@/lib/checkout-reconcile/policy'

import {
	STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
	type StripeCheckoutSessionCompleted,
} from '@coursebuilder/core/events/stripe'

export type CheckoutRecoveryArgs = {
	checkoutSessionId: string
	apply: boolean
	/** Skip the replay and run the checkout handler in this process. */
	direct: boolean
	receiptPath?: string
}

export type CheckoutRecoveryState = CheckoutFulfillmentState

export type CheckoutRecoveryRuntime = {
	getCheckoutSession: (checkoutSessionId: string) => Promise<Stripe.Checkout.Session>
	inspect: (input: {
		checkoutSessionId: string
		chargeId: string
	}) => Promise<CheckoutRecoveryState>
	sendReplay: (event: {
		id: string
		name: typeof STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT
		data: StripeCheckoutSessionCompleted['data']
	}) => Promise<{ ids: string[] }>
	/**
	 * Polls Inngest for runs of the sent replay. Resolves to the run count, or
	 * null when the command cannot read the Inngest API.
	 */
	countReplayRuns: (eventIds: string[]) => Promise<number | null>
	/** Runs the registered checkout handler directly. Apply mode only. */
	fulfillDirect: (
		checkoutSessionId: string,
	) => Promise<DirectCheckoutFulfillmentResult>
	close: () => Promise<void>
}

export type CheckoutRecoveryReceipt = {
	version: 2
	checkoutSessionId: string
	mode: 'dry-run' | 'apply'
	status:
		| 'would_replay'
		| 'replay_requested'
		| 'would_fulfill_direct'
		| 'fulfilled_direct'
		| 'already_recovered'
		| 'refused'
	success: boolean
	chargeId: string | null
	recoveryEventId: string | null
	inngestEventIds: string[]
	/** Runs Inngest created for the replay; null when not checked. */
	replayRunCount: number | null
	/** Why the handler ran directly: `--direct`, or a replay with no run. */
	directReason: 'requested' | 'replay_produced_no_run' | null
	purchaseId: string | null
	state: CheckoutRecoveryState | null
	reason: string | null
}

const CHECKOUT_SESSION_PATTERN = /^cs_(?:(?:test|live)_)?[A-Za-z0-9]+$/

export function parseCheckoutRecoveryArgs(argv: readonly string[]): CheckoutRecoveryArgs {
	let checkoutSessionId: string | undefined
	let receiptPath: string | undefined
	let apply = false
	let direct = false

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--apply') {
			apply = true
			continue
		}
		if (argument === '--direct') {
			direct = true
			continue
		}
		if (argument === '--checkout-session-id' || argument === '--receipt') {
			const value = argv[index + 1]
			if (!value || value.startsWith('--')) {
				throw new Error(`${argument} requires a value`)
			}
			if (argument === '--checkout-session-id') checkoutSessionId = value
			if (argument === '--receipt') receiptPath = value
			index += 1
			continue
		}
		throw new Error(`Unknown argument: ${argument}`)
	}

	if (!checkoutSessionId || !CHECKOUT_SESSION_PATTERN.test(checkoutSessionId)) {
		throw new Error('--checkout-session-id must be one exact Stripe session id')
	}

	return { checkoutSessionId, apply, direct, receiptPath }
}

function objectId(value: string | { id: string } | null): string | null {
	if (!value) return null
	return typeof value === 'string' ? value : value.id
}

function chargeIdFromSession(session: Stripe.Checkout.Session): string | null {
	const paymentIntent = session.payment_intent
	if (!paymentIntent || typeof paymentIntent === 'string') return null
	const latestCharge = paymentIntent.latest_charge
	return latestCharge ? objectId(latestCharge) : null
}

export function recoveryEventId(checkoutSessionId: string) {
	const digest = createHash('sha256').update(checkoutSessionId).digest('hex')
	return `aih-checkout-recovery-${digest.slice(0, 48)}`
}

function buildReplayData(
	session: Stripe.Checkout.Session,
): StripeCheckoutSessionCompleted['data'] {
	return buildCheckoutCompletedEventData(session, recoveryEventId(session.id))
}

function receipt(
	args: Pick<CheckoutRecoveryArgs, 'checkoutSessionId' | 'apply'>,
	fields: Pick<CheckoutRecoveryReceipt, 'status' | 'success'> &
		Partial<CheckoutRecoveryReceipt>,
): CheckoutRecoveryReceipt {
	return {
		version: 2,
		checkoutSessionId: args.checkoutSessionId,
		mode: args.apply ? 'apply' : 'dry-run',
		chargeId: null,
		recoveryEventId: null,
		inngestEventIds: [],
		replayRunCount: null,
		directReason: null,
		purchaseId: null,
		state: null,
		reason: null,
		...fields,
	}
}

function refused(
	checkoutSessionId: string,
	apply: boolean,
	reason: string,
): CheckoutRecoveryReceipt {
	return receipt(
		{ checkoutSessionId, apply },
		{ status: 'refused', success: false, reason },
	)
}

/** Maps a direct fulfillment onto the receipt, keeping replay evidence. */
function directReceipt(
	args: CheckoutRecoveryArgs,
	result: DirectCheckoutFulfillmentResult,
	evidence: Partial<CheckoutRecoveryReceipt> &
		Pick<CheckoutRecoveryReceipt, 'directReason'>,
): CheckoutRecoveryReceipt {
	if (result.status === 'fulfilled') {
		return receipt(args, {
			...evidence,
			status: 'fulfilled_direct',
			success: true,
			chargeId: result.chargeId,
			purchaseId: result.purchaseId,
			state: result.state,
		})
	}
	if (result.status === 'skipped') {
		return receipt(args, {
			...evidence,
			status: 'refused',
			success: false,
			chargeId: result.chargeId,
			reason: `Direct fulfillment skipped: ${result.reason}`,
		})
	}
	return receipt(args, {
		...evidence,
		status: 'already_recovered',
		success: true,
		chargeId: result.chargeId,
		purchaseId: result.purchaseIds[0] ?? null,
		state: result.state,
		reason: result.status === 'raced' ? 'Another run created the purchase first' : null,
	})
}

export async function runCheckoutRecovery(
	args: CheckoutRecoveryArgs,
	runtime: CheckoutRecoveryRuntime,
): Promise<CheckoutRecoveryReceipt> {
	try {
		const session = await runtime.getCheckoutSession(args.checkoutSessionId)
		if (session.id !== args.checkoutSessionId) {
			return refused(args.checkoutSessionId, args.apply, 'Stripe returned a different session')
		}
		if (
			session.mode !== 'payment' ||
			session.status !== 'complete' ||
			session.payment_status !== 'paid'
		) {
			return refused(
				args.checkoutSessionId,
				args.apply,
				'Checkout session is not a completed paid one-time payment',
			)
		}

		const chargeId = chargeIdFromSession(session)
		if (!chargeId?.startsWith('ch_')) {
			return refused(
				args.checkoutSessionId,
				args.apply,
				'Checkout session has no expanded Stripe charge',
			)
		}
		const charge = checkoutChargeState(session)
		if (charge.refunded || charge.disputed) {
			return refused(
				args.checkoutSessionId,
				args.apply,
				charge.refunded
					? 'Checkout charge is refunded'
					: 'Checkout charge is disputed',
			)
		}

		const state = await runtime.inspect({
			checkoutSessionId: args.checkoutSessionId,
			chargeId,
		})
		if (state.purchaseIds.length > 0) {
			return receipt(args, {
				status: 'already_recovered',
				success: true,
				chargeId,
				state,
				purchaseId: state.purchaseIds[0] ?? null,
			})
		}

		if (args.direct) {
			if (!args.apply) {
				return receipt(args, {
					status: 'would_fulfill_direct',
					success: true,
					chargeId,
					directReason: 'requested',
					state,
				})
			}
			return directReceipt(
				args,
				await runtime.fulfillDirect(args.checkoutSessionId),
				{ directReason: 'requested' },
			)
		}

		const eventId = recoveryEventId(args.checkoutSessionId)
		if (!args.apply) {
			return receipt(args, {
				status: 'would_replay',
				success: true,
				chargeId,
				recoveryEventId: eventId,
				state,
			})
		}

		const sent = await runtime.sendReplay({
			id: eventId,
			name: STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
			data: buildReplayData(session),
		})
		if (sent.ids.length === 0) {
			return receipt(args, {
				status: 'replay_requested',
				success: false,
				chargeId,
				recoveryEventId: eventId,
				state,
				reason: 'Inngest returned no event id',
			})
		}

		// Within 24 hours of the original event the core function's
		// idempotency key (the session id) is spent, so Inngest accepts the
		// replay and runs nothing. That is the 2026-10-09 failure; fall back to
		// running the handler here.
		let replayRunCount: number | null = null
		let replayCheckError: string | null = null
		try {
			replayRunCount = await runtime.countReplayRuns(sent.ids)
		} catch (error) {
			replayCheckError = error instanceof Error ? error.message : String(error)
		}
		const replayEvidence = {
			recoveryEventId: eventId,
			inngestEventIds: sent.ids,
			replayRunCount,
		}
		if (replayRunCount === 0) {
			return directReceipt(
				args,
				await runtime.fulfillDirect(args.checkoutSessionId),
				{ ...replayEvidence, directReason: 'replay_produced_no_run' },
			)
		}
		return receipt(args, {
			...replayEvidence,
			status: 'replay_requested',
			success: true,
			chargeId,
			state,
			reason:
				replayRunCount === null
					? `Replay run not verified (${replayCheckError ?? 'no INNGEST_SIGNING_KEY'}). If no run appears, rerun with --direct.`
					: null,
		})
	} catch (error) {
		return refused(
			args.checkoutSessionId,
			args.apply,
			error instanceof Error ? error.message : 'Unknown checkout recovery error',
		)
	}
}

async function createProductionRuntime(
	args: CheckoutRecoveryArgs,
): Promise<CheckoutRecoveryRuntime> {
	const { createCheckoutRecoveryRuntime, resolveCheckoutRecoveryEnv } =
		await import('./checkout-recovery-runtime')
	const env = resolveCheckoutRecoveryEnv(process.env, { apply: args.apply })
	return createCheckoutRecoveryRuntime(env)
}

async function writeReceiptFile(path: string, receipt: CheckoutRecoveryReceipt) {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

async function main() {
	let runtime: CheckoutRecoveryRuntime | undefined
	try {
		const args = parseCheckoutRecoveryArgs(process.argv.slice(2))
		runtime = await createProductionRuntime(args)
		const receipt = await runCheckoutRecovery(args, runtime)
		const receiptPath = resolve(
			args.receiptPath ??
				`tmp/checkout-recovery/${args.checkoutSessionId}-${args.direct ? 'direct-' : ''}${args.apply ? 'apply' : 'dry-run'}.json`,
		)
		await writeReceiptFile(receiptPath, receipt)
		console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2))
		process.exitCode = receipt.success ? 0 : 1
	} catch (error) {
		console.error(
			JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			}),
		)
		process.exitCode = 1
	} finally {
		await runtime?.close()
	}
}

const isMain = process.argv[1]
	? pathToFileURL(process.argv[1]).href === import.meta.url
	: false

if (isMain) void main()
