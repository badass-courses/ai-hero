import { SYNTHETIC_CHECKOUT_REFUSED } from '@/coursebuilder/synthetic-checkout'
import {
	checkoutLoginHandoffProviderIdempotencyKey,
	type CheckoutLoginHandoffPayload,
} from '@/lib/checkout-login-handoff'
import type {
	CheckoutLoginHandoffClaim,
	CheckoutLoginHandoffStore,
} from '@/lib/checkout-login-handoff-store'
import { PURCHASE_BLOCKED } from '@/lib/purchase-block'
import { isUserBlockedFromPurchasing } from '@/lib/purchase-disputes'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

import type { CommerceAdapter } from '@coursebuilder/commerce'
import type {
	CheckoutParams,
	CheckoutSessionResult,
	StripePaymentsProviderConfig,
} from '@coursebuilder/core/types'

function verifiedStripeCheckoutReceipt(
	result: Extract<CheckoutSessionResult, { kind: 'success' }>,
) {
	if (!result.providerSessionId.startsWith('cs_')) return false
	try {
		const url = new URL(result.redirect)
		return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
	} catch {
		return false
	}
}

async function releaseClaimAfterCompletionFailure(
	store: CheckoutLoginHandoffStore,
	claim: CheckoutLoginHandoffClaim,
) {
	try {
		await store.failRetryable({ claim })
	} catch {
		// The claim lease remains the final process-loss recovery boundary when
		// the database cannot record either completion or immediate release.
	}
}

export async function createLoggedInCheckoutSession({
	provider,
	adapter,
	handoffStore,
	claim,
	handoffPayload,
	checkoutParams,
	isPurchaseBlocked = isUserBlockedFromPurchasing,
}: {
	provider: StripePaymentsProviderConfig
	adapter: CommerceAdapter
	handoffStore: CheckoutLoginHandoffStore
	claim?: CheckoutLoginHandoffClaim
	handoffPayload?: CheckoutLoginHandoffPayload
	checkoutParams: CheckoutParams
	isPurchaseBlocked?: (userId: string) => Promise<boolean>
}): Promise<CheckoutSessionResult> {
	if (claim && !handoffPayload) {
		throw new Error('missing-checkout-login-handoff-payload')
	}

	// Synthetic test principals (#36T) never reach Stripe until T8 defines a
	// checkout-under-test contract. This is the signed-in checkout entry; the
	// coursebuilder route refuses the other one.
	if (isSyntheticPrincipalId(checkoutParams.userId)) {
		// A claim this request no longer owns is the same write failure the
		// provider-failure path below reports; never claim a refusal applied.
		if (
			claim &&
			!(await handoffStore.failTerminal({
				claim,
				failureCode: SYNTHETIC_CHECKOUT_REFUSED,
			}))
		) {
			throw new Error('checkout-login-handoff-failure-write-failed')
		}
		return {
			kind: 'failure',
			failure: { code: SYNTHETIC_CHECKOUT_REFUSED, retryable: false },
		}
	}

	// A buyer who lost a chargeback never gets a new Stripe session.
	if (
		checkoutParams.userId &&
		(await isPurchaseBlocked(checkoutParams.userId))
	) {
		if (
			claim &&
			!(await handoffStore.failTerminal({
				claim,
				failureCode: PURCHASE_BLOCKED,
			}))
		) {
			throw new Error('checkout-login-handoff-failure-write-failed')
		}
		return {
			kind: 'failure',
			failure: { code: PURCHASE_BLOCKED, retryable: false },
		}
	}

	const result = claim
		? await provider.createCheckoutSessionResult(checkoutParams, adapter, {
				idempotencyKey: checkoutLoginHandoffProviderIdempotencyKey(
					claim.nonceHash,
				),
				operationStartedAt: new Date(handoffPayload!.issuedAt),
			})
		: await provider.createCheckoutSessionResult(checkoutParams, adapter)

	if (result.kind === 'failure') {
		if (claim) {
			const transitioned = result.failure.retryable
				? await handoffStore.failRetryable({ claim })
				: await handoffStore.failTerminal({
						claim,
						failureCode: result.failure.code,
					})
			if (!transitioned) {
				throw new Error('checkout-login-handoff-failure-write-failed')
			}
		}
		return result
	}

	if (!verifiedStripeCheckoutReceipt(result)) {
		const failure: CheckoutSessionResult = {
			kind: 'failure',
			failure: {
				code: 'invalid-stripe-checkout-receipt',
				retryable: false,
			},
		}
		if (claim) {
			const transitioned = await handoffStore.failTerminal({
				claim,
				failureCode: failure.failure.code,
			})
			if (!transitioned) {
				throw new Error('checkout-login-handoff-failure-write-failed')
			}
		}
		return failure
	}

	if (claim) {
		try {
			const receiptStored = await handoffStore.complete({
				claim,
				receipt: {
					providerSessionId: result.providerSessionId,
					redirect: result.redirect,
				},
			})
			if (!receiptStored) {
				throw new Error('checkout-login-handoff-receipt-write-failed')
			}
		} catch (error) {
			await releaseClaimAfterCompletionFailure(handoffStore, claim)
			throw error
		}
	}

	return result
}
