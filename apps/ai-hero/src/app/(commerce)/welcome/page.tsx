import * as React from 'react'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import Link from 'next/link'
import { purchaseBuyPathContext } from '@/lib/buy-path/read-context'
import { redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { purchaseArtwork } from '@/lib/purchase-artwork'
import { PostPurchaseShell } from '../_components/post-purchase-shell'
import { PostPurchaseArrival } from '../_components/post-purchase-arrival'
import { PostPurchaseIconBadge } from '../_components/post-purchase-icon'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter, db } from '@/db'
import { env } from '@/env.mjs'
import { differentAccountCopy, purchaseViewerState } from '@/lib/purchase-viewer'
import { getSubscription } from '@/lib/subscriptions'
import {
	discordAccountsForCurrentUser,
	githubAccountsForCurrentUser,
} from '@/lib/users'
import {
	cancelPurchaseTransfer,
	getPurchaseTransferForPurchaseId,
	initiatePurchaseTransfer,
} from '@/purchase-transfer/purchase-transfer-actions'
import { isTransferablePurchase } from '@/purchase-transfer/transfer-lifecycle'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'

import {
	SubscriptionWelcomePage,
	type StripeSubscriptionData,
} from '@coursebuilder/commerce-next/post-purchase/subscription-welcome-page'
import { convertToSerializeForNextResponse } from '@coursebuilder/commerce-next/utils/serialize-for-next-response'
import { PostPurchaseDiscordAccess } from './welcome-discord-entry'
import { productPagePath, welcomeStart } from './welcome-start'
import {
	PURCHASE_PRIMARY_BUTTON,
	PurchaseCard,
	PurchaseCardSection,
	PurchaseHeading,
	PurchaseRows,
} from '../_components/post-purchase-parts'
import {
	PurchaseInviteTeam,
	PurchaseInvoiceRow,
	PurchaseShareRow,
	PurchaseTransferRow,
} from '../_components/post-purchase-receipt'
import { TYPE } from '@/components/landing/type'
import { ArrowRight } from 'lucide-react'
import { cn } from '@coursebuilder/ui/utils/cn'
import { PurchaseUserTransfer } from '@coursebuilder/core/schemas'
import { PurchaseInfoSchema } from '@coursebuilder/core/schemas/purchase-info'
import { isString } from '@coursebuilder/nodash'

async function getPurchaseForChargeId(chargeIdentifier: string) {
	const maxRetries = 5
	const initialDelay = 150
	const maxDelay = 15000

	let retries = 0
	let delay = initialDelay

	while (retries < maxRetries) {
		try {
			const purchase =
				await courseBuilderAdapter.getPurchaseForStripeCharge(chargeIdentifier)

			if (!purchase) {
				throw new Error('purchase not found')
			}

			return purchase
		} catch (error) {
			retries++
			await new Promise((resolve) => setTimeout(resolve, delay))
			delay = Math.min(delay * 2, maxDelay)
		}
	}
}

const getPurchaseDetailsForWelcome = async (query: {
	session_id: string
	provider: string
	purchaseId?: string
	subscriptionId?: string
	upgrade?: 'true'
}) => {
	const token = await getServerAuthSession()
	const user = token.session?.user

	let purchaseId = query.purchaseId

	const session_id = query.session_id

	const paymentProvider = stripeProvider

	if (session_id && paymentProvider) {
		const purchaseInfo = await paymentProvider.getPurchaseInfo(
			session_id,
			courseBuilderAdapter,
		)

		if (
			'error' in purchaseInfo &&
			purchaseInfo.error === 'paymentSucceededButProcessingFailed'
		) {
			redirect(`/thanks/purchase?session_id=${session_id}`)
		}

		const validPurchaseInfo = PurchaseInfoSchema.parse(purchaseInfo)
		const { chargeIdentifier } = validPurchaseInfo

		const purchase = await getPurchaseForChargeId(chargeIdentifier)

		if (purchase) {
			purchaseId = purchase.id
		} else {
			redirect(`/thanks/purchase?session_id=${session_id}`)
		}
	}

	if (user && isString(purchaseId) && isString(user?.id)) {
		const claimed = await courseBuilderAdapter.getPurchase(purchaseId)
		const viewerState = purchaseViewerState({
			viewerUserId: user.id,
			purchaseExists: Boolean(claimed),
			purchaseOwnerId: claimed?.userId,
		})
		if (viewerState === 'different-account') {
			return { differentAccount: true as const, viewerEmail: user.email }
		}

		const { purchase, existingPurchase, availableUpgrades } =
			await courseBuilderAdapter.getPurchaseDetails(purchaseId, user?.id)

		if (purchase) {
			const product = await courseBuilderAdapter.getProduct(purchase.productId)
			const productResources = await courseBuilderAdapter.getProductResources(
				purchase.productId,
			)

			return {
				product,
				productResources,
				purchase: convertToSerializeForNextResponse(purchase),
				existingPurchase,
				availableUpgrades,
				upgrade: query.upgrade === 'true',
			}
		} else {
			redirect(`/`)
		}
	}

	redirect(`/`)
}

const Welcome = async (props: {
	searchParams: Promise<{
		session_id: string
		provider: string
		purchaseId?: string
		subscriptionId?: string
		buyPathId?: string
		buyPathWaited?: string
	}>
}) => {
	const searchParams = await props.searchParams
	await headers()
	const { session, ability } = await getServerAuthSession()

	const { purchaseId, subscriptionId } = searchParams

	if (purchaseId) {
		const details = await getPurchaseDetailsForWelcome(searchParams)
		if ('differentAccount' in details) {
			const copy = differentAccountCopy(details.viewerEmail)
			return (
				<LayoutClient withContainer>
					<section className="px-[18px] py-20 sm:px-11 md:py-24">
						<h1 className="text-3xl font-normal leading-tight tracking-tight sm:text-4xl">
							{copy.title}
						</h1>
						<p className="text-foreground/70 mt-4 max-w-2xl text-lg leading-relaxed">
							{copy.description}
						</p>
					</section>
				</LayoutClient>
			)
		}
		const {
			upgrade,
			purchase,
			existingPurchase,
			product,
			productResources,
		} = details

		const buyPath = searchParams.buyPathId
			? null
			: await purchaseBuyPathContext(purchase.id).catch(() => null)
		const redemptionsLeft =
			purchase.bulkCoupon &&
			purchase.bulkCoupon.maxUses > purchase.bulkCoupon.usedCount

		const hasCharge = Boolean(purchase.merchantChargeId)

		const purchaseUserTransfers = await getPurchaseTransferForPurchaseId({
			id: purchase.id,
		})

		const isTransferAvailable =
			!purchase.bulkCoupon &&
			isTransferablePurchase(purchase) &&
			Boolean(
				purchaseUserTransfers?.filter(
					(purchaseUserTransfer: PurchaseUserTransfer) =>
						['AVAILABLE', 'INITIATED', 'COMPLETED'].includes(
							purchaseUserTransfer.transferState,
						),
				).length,
			)

		const isDiscordConnected = await discordAccountsForCurrentUser()
		const owned = purchase.bulkCoupon ? existingPurchase : purchase
		const start = welcomeStart({
			product,
			productResources,
			ownsASeat: Boolean(owned),
		})
		const productName =
			purchase.product?.name || product?.name || 'your purchase'
		const eyebrow =
			purchase.product?.type === 'live'
				? 'Thank you for purchasing'
				: upgrade
					? "You've upgraded"
					: 'Welcome to'

		return (
			<PostPurchaseShell
				step="ready"
				paymentConfirmed
				handover={Boolean(searchParams.buyPathId)}
				landmark="section"
			>
				<PostPurchaseArrival
					destination="welcome"
					checkoutSessionId={searchParams.buyPathId ?? buyPath?.buyPathId}
					purchaseWasPolled={searchParams.buyPathWaited === '1'}
				/>
				<PurchaseCard>
					<PurchaseCardSection>
						<PurchaseHeading
							artwork={purchaseArtwork(product)}
							badge={
								<PostPurchaseIconBadge kind="ready" size="sm" />
							}
							eyebrow={eyebrow}
							title={productName}
						>
							{start ? (
								<div className="flex flex-col items-start gap-2 pt-3">
									<Link href={start.href} className={PURCHASE_PRIMARY_BUTTON}>
										{start.label}
										<ArrowRight
											aria-hidden="true"
											className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
										/>
									</Link>
									{start.startsLabel ? (
										<p className={cn(TYPE.metaSm, 'text-muted-foreground')}>
											{start.startsLabel}
										</p>
									) : null}
								</div>
							) : null}
						</PurchaseHeading>
					</PurchaseCardSection>
					{isDiscordConnected ? null : (
						<PurchaseCardSection>
							<PostPurchaseDiscordAccess isDiscordConnected={false} />
						</PurchaseCardSection>
					)}
					{redemptionsLeft ? (
						<PurchaseCardSection>
							<PurchaseInviteTeam
								purchase={purchase}
								existingPurchase={existingPurchase}
								userEmail={session?.user?.email}
								disabled={!redemptionsLeft}
								canClaim
							/>
						</PurchaseCardSection>
					) : null}
				</PurchaseCard>
				<PurchaseRows>
					{hasCharge ? (
						<PurchaseInvoiceRow purchase={purchase} productName={productName} />
					) : null}
					{isTransferAvailable ? (
						<PurchaseTransferRow
							onTransferInitiated={async () => {
								'use server'
								revalidatePath('/welcome')
							}}
							purchaseUserTransfers={purchaseUserTransfers}
							cancelPurchaseTransfer={cancelPurchaseTransfer}
							initiatePurchaseTransfer={initiatePurchaseTransfer}
						/>
					) : null}
					<PurchaseShareRow
						productName={productName}
						productPath={productPagePath(productResources)}
					/>
				</PurchaseRows>
			</PostPurchaseShell>
		)
	}

	if (subscriptionId) {
		const subscription = await getSubscription(subscriptionId)

		if (!subscription?.merchantSubscription?.identifier) {
			redirect(`/`)
		}

		const rawStripeSubscription = await stripeProvider.getSubscription(
			subscription?.merchantSubscription?.identifier,
		)

		// Extract only serializable data from Stripe subscription
		const stripeSubscription: StripeSubscriptionData = {
			status: rawStripeSubscription.status,
			quantity: rawStripeSubscription.items.data[0]?.quantity ?? 1,
			interval:
				rawStripeSubscription.items.data[0]?.price.recurring?.interval ??
				'month',
			currentPeriodEnd: rawStripeSubscription.current_period_end,
			cancelAtPeriodEnd: rawStripeSubscription.cancel_at_period_end,
			unitAmount:
				rawStripeSubscription.items.data[0]?.price.unit_amount ?? null,
			currency: rawStripeSubscription.items.data[0]?.price.currency ?? 'usd',
		}

		// Only provide billing portal URL if user can manage billing for the org
		// Uses organization role permissions - only owners/admins can manage billing
		let billingPortalUrl: string | null = null
		const canManageBilling =
			subscription.organizationId &&
			ability.can(
				'read',
				subject('OrganizationBilling', {
					organizationId: subscription.organizationId,
				}),
			)

		if (canManageBilling) {
			billingPortalUrl = await stripeProvider.getBillingPortalUrl(
				typeof rawStripeSubscription.customer === 'string'
					? rawStripeSubscription.customer
					: rawStripeSubscription.customer.id,
				`${env.COURSEBUILDER_URL}/welcome?subscriptionId=${subscription.id}`,
			)
		}

		const isGithubConnected = await githubAccountsForCurrentUser()
		const isDiscordConnected = await discordAccountsForCurrentUser()

		// Check if this is a team subscription (seats > 1)
		let teamSection: React.ReactNode = null

		return (
			<LayoutClient withContainer>
				<SubscriptionWelcomePage
					subscription={subscription}
					stripeSubscription={stripeSubscription}
					isGithubConnected={isGithubConnected}
					isDiscordConnected={isDiscordConnected}
					billingPortalUrl={billingPortalUrl}
				/>
			</LayoutClient>
		)
	}
}

export default Welcome
