import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Stripe from 'stripe'

import {
	STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
	type StripeCheckoutSessionCompleted,
} from '@coursebuilder/core/inngest/stripe/event-checkout-session-completed'
import { checkoutSessionCompletedEvent } from '@coursebuilder/core/schemas/stripe/checkout-session-completed'

export type CheckoutRecoveryArgs = {
	checkoutSessionId: string
	apply: boolean
	receiptPath?: string
}

export type CheckoutRecoveryState = {
	chargeIds: string[]
	merchantSessionIds: string[]
	purchaseIds: string[]
}

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
	close: () => Promise<void>
}

export type CheckoutRecoveryReceipt = {
	version: 1
	checkoutSessionId: string
	mode: 'dry-run' | 'apply'
	status: 'would_replay' | 'replay_requested' | 'already_recovered' | 'refused'
	success: boolean
	chargeId: string | null
	recoveryEventId: string | null
	inngestEventIds: string[]
	state: CheckoutRecoveryState | null
	reason: string | null
}

const CHECKOUT_SESSION_PATTERN = /^cs_(?:(?:test|live)_)?[A-Za-z0-9]+$/

export function parseCheckoutRecoveryArgs(argv: readonly string[]): CheckoutRecoveryArgs {
	let checkoutSessionId: string | undefined
	let receiptPath: string | undefined
	let apply = false

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--apply') {
			apply = true
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

	return { checkoutSessionId, apply, receiptPath }
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

function recoveryEventId(checkoutSessionId: string) {
	const digest = createHash('sha256').update(checkoutSessionId).digest('hex')
	return `aih-checkout-recovery-${digest.slice(0, 48)}`
}

function buildReplayData(
	session: Stripe.Checkout.Session,
): StripeCheckoutSessionCompleted['data'] {
	const customerId = objectId(session.customer)
	const paymentIntentId = objectId(session.payment_intent)
	if (!customerId || !paymentIntentId || !session.customer_details) {
		throw new Error('Checkout session lacks customer or payment intent evidence')
	}

	const stripeEvent = checkoutSessionCompletedEvent.parse({
		id: `evt_${recoveryEventId(session.id)}`,
		created: session.created,
		type: 'checkout.session.completed',
		data: {
			object: {
				...session,
				amount_subtotal: session.amount_subtotal ?? session.amount_total ?? 0,
				amount_total: session.amount_total ?? 0,
				custom_fields: session.custom_fields ?? [],
				customer: customerId,
				customer_details: session.customer_details,
				metadata: session.metadata ?? {},
				payment_intent: paymentIntentId,
				payment_method_collection:
					session.payment_method_collection ?? 'always',
				phone_number_collection:
					session.phone_number_collection ?? { enabled: false },
				subscription: null,
				success_url: session.success_url ?? '',
				total_details: session.total_details ?? {
					amount_discount: 0,
					amount_shipping: 0,
					amount_tax: 0,
				},
			},
		},
	})

	return {
		txnId: recoveryEventId(session.id),
		stripeEvent,
	}
}

function refused(
	checkoutSessionId: string,
	apply: boolean,
	reason: string,
): CheckoutRecoveryReceipt {
	return {
		version: 1,
		checkoutSessionId,
		mode: apply ? 'apply' : 'dry-run',
		status: 'refused',
		success: false,
		chargeId: null,
		recoveryEventId: null,
		inngestEventIds: [],
		state: null,
		reason,
	}
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

		const state = await runtime.inspect({
			checkoutSessionId: args.checkoutSessionId,
			chargeId,
		})
		if (state.purchaseIds.length > 0) {
			return {
				version: 1,
				checkoutSessionId: args.checkoutSessionId,
				mode: args.apply ? 'apply' : 'dry-run',
				status: 'already_recovered',
				success: true,
				chargeId,
				recoveryEventId: null,
				inngestEventIds: [],
				state,
				reason: null,
			}
		}

		const eventId = recoveryEventId(args.checkoutSessionId)
		if (!args.apply) {
			return {
				version: 1,
				checkoutSessionId: args.checkoutSessionId,
				mode: 'dry-run',
				status: 'would_replay',
				success: true,
				chargeId,
				recoveryEventId: eventId,
				inngestEventIds: [],
				state,
				reason: null,
			}
		}

		const sent = await runtime.sendReplay({
			id: eventId,
			name: STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
			data: buildReplayData(session),
		})
		return {
			version: 1,
			checkoutSessionId: args.checkoutSessionId,
			mode: 'apply',
			status: 'replay_requested',
			success: sent.ids.length > 0,
			chargeId,
			recoveryEventId: eventId,
			inngestEventIds: sent.ids,
			state,
			reason: sent.ids.length > 0 ? null : 'Inngest returned no event id',
		}
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
				`tmp/checkout-recovery/${args.checkoutSessionId}-${args.apply ? 'apply' : 'dry-run'}.json`,
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
