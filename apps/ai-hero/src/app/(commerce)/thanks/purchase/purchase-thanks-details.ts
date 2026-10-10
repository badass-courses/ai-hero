import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter } from '@/db'
import { convertToSerializeForNextResponse } from '@coursebuilder/commerce-next/utils/serialize-for-next-response'
import { checkForPaymentSuccessWithoutPurchase } from '@coursebuilder/commerce'
import { logger } from '@coursebuilder/utils/logger'

export const getPurchaseThanksDetails = async (
	session_id: string,
	options: { maxRetries?: number } = {},
) => {
	const paymentProvider = stripeProvider

	if (!paymentProvider) {
		throw new Error('No payment provider found')
	}

	if (!session_id) {
		throw new Error(`No session_id found: ${session_id}`)
	}

	logger.info('purchase.thanks-page.loading', {
		checkoutSessionId: session_id,
	})

	const maxRetries = options.maxRetries ?? 30
	const initialDelay = 100
	const maxDelay = 1000

	let retries = 0
	let delay = initialDelay

	while (retries < maxRetries) {
		try {
			const purchaseInfo = await paymentProvider.getPurchaseInfo(
				session_id,
				courseBuilderAdapter,
			)

			if (
				'error' in purchaseInfo &&
				purchaseInfo.error === 'paymentSucceededButProcessingFailed'
			) {
				return {
					paymentSucceededButProcessingFailed: true,
				}
			}

			const {
				email,
				chargeIdentifier,
				quantity: seatsPurchased,
				product: merchantProduct,
				purchaseType,
			} = purchaseInfo

			const stripeProductName = merchantProduct.name

			const purchase =
				await courseBuilderAdapter.getPurchaseForStripeCharge(chargeIdentifier)

			if (!purchase || !email) {
				throw new Error('Purchase or email not found')
			}

			const product = await courseBuilderAdapter.getProduct(purchase.productId)

			const redemptionsLeft =
				purchase.bulkCoupon &&
				purchase.bulkCoupon.maxUses > purchase.bulkCoupon.usedCount

			logger.info('purchase.thanks-page.loaded', {
				checkoutSessionId: session_id,
				purchaseId: purchase.id,
				productId: purchase.productId,
				purchaseType,
				seatsPurchased,
				retries,
			})

			return {
				purchase: convertToSerializeForNextResponse(purchase),
				email,
				seatsPurchased,
				redemptionsLeft,
				purchaseType,
				bulkCouponId: purchase.bulkCoupon?.id || null,
				product: convertToSerializeForNextResponse(product) || null,
				stripeProductName,
			}
		} catch (error) {
			retries++
			logger.debug('thanks purchase poll retry', {
				sessionId: session_id,
				retries,
				maxRetries,
				error: error instanceof Error ? error.message : String(error),
			})
			await new Promise((resolve) => setTimeout(resolve, delay))
			delay = Math.min(delay * 2, maxDelay)
		}
	}

	const errorCheck = await checkForPaymentSuccessWithoutPurchase(
		session_id,
		courseBuilderAdapter,
	).catch(() => ({ shouldShowError: false, stripeEventId: undefined }))

	if (errorCheck.shouldShowError) {
		logger.debug('thanks purchase poll success-no-purchase fallback', {
			sessionId: session_id,
			stripeEventId: errorCheck.stripeEventId,
		})
		return {
			paymentSucceededButProcessingFailed: true,
		}
	}

	logger.error(
		new Error('purchase missing after polling and no Stripe fallback', {
			cause: {
				sessionId: session_id,
			},
		}),
	)
	return { processingUnconfirmed: true }
}
