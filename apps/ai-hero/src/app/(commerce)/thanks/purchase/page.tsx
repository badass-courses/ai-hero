import * as React from 'react'
import { Suspense } from 'react'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { purchaseArtwork } from '@/lib/purchase-artwork'
import { PostPurchaseShell } from '../../_components/post-purchase-shell'
import { PostPurchaseArrival } from '../../_components/post-purchase-arrival'
import { PostPurchaseLoginLink } from '../../_components/post-purchase-login-link'
import { PostPurchaseIconBadge } from '../../_components/post-purchase-icon'
import { getPurchaseThanksDetails } from './purchase-thanks-details'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { isCheckoutSessionOwner } from '@/lib/checkout-owner-resolution'
import {
	cancelPurchaseTransfer,
	getPurchaseTransferForPurchaseId,
	initiatePurchaseTransfer,
} from '@/purchase-transfer/purchase-transfer-actions'
import { getServerAuthSession } from '@/server/auth'
import { TYPE } from '@/components/landing/type'
import { PurchaseStatusPoller } from './purchase-status-poller'
import {
	PurchaseCard,
	PurchaseCardSection,
	PurchaseHeading,
	PurchaseRows,
} from '../../_components/post-purchase-parts'
import {
	PurchaseInviteTeam,
	PurchaseInvoiceRow,
	PurchaseTransferRow,
} from '../../_components/post-purchase-receipt'

import { cn } from '@coursebuilder/ui/utils/cn'
import {
	EXISTING_BULK_COUPON,
	INDIVIDUAL_TO_BULK_UPGRADE,
	NEW_BULK_COUPON,
	NEW_INDIVIDUAL_PURCHASE,
} from '@coursebuilder/core/schemas/purchase-type'

export const maxDuration = 100

/**
 * Server component that validates a Stripe checkout session and renders the
 * thank-you experience or redirects once the purchase is created.
 *
 * @param props - Route props containing purchase session identifiers
 */
export default async function ThanksPurchasePage(props: {
	searchParams: Promise<{
		session_id: string
		provider: string
		ready?: string
	}>
}) {
	const searchParams = await props.searchParams
	await headers()

	const { session_id, ready } = searchParams

	if (!session_id || !session_id.startsWith('cs_')) {
		notFound()
	}

	if (
		typeof courseBuilderAdapter.getPurchaseByCheckoutSessionId !== 'function'
	) {
		throw new Error('Checkout session purchase lookup is unavailable')
	}

	const purchase =
		await courseBuilderAdapter.getPurchaseByCheckoutSessionId(session_id)

	if (!purchase?.id) {
		return <PurchaseProcessingPage session_id={session_id} />
	}

	return (
		<Suspense fallback={<PageLoading />}>
			<PurchaseThanksPageLoaded session_id={session_id} ready={ready === '1'} />
		</Suspense>
	)
}

function PurchaseProcessingPage({ session_id }: { session_id: string }) {
	return <PurchaseStatusPoller sessionId={session_id} />
}

function PageLoading() {
	return <PostPurchaseShell />
}

async function PurchaseThanksPageLoaded({
	session_id,
	ready,
}: {
	session_id: string
	ready: boolean
}) {
	const token = await getServerAuthSession()

	const result = await getPurchaseThanksDetails(session_id, {
		maxRetries: ready ? 5 : 1,
	})

	if (
		'paymentSucceededButProcessingFailed' in result ||
		'processingUnconfirmed' in result
	) {
		return (
			<PostPurchaseShell
				step="failed"
				paymentConfirmed={'paymentSucceededButProcessingFailed' in result}
				supportEmail={env.NEXT_PUBLIC_SUPPORT_EMAIL}
			/>
		)
	}

	const {
		purchase,
		email,
		seatsPurchased,
		purchaseType,
		bulkCouponId,
		product,
		stripeProductName,
		redemptionsLeft,
	} = result

	if (
		isCheckoutSessionOwner({
			purchaseUserId: purchase.userId ?? null,
			purchaseEmail: email ?? null,
			sessionUserId: token?.session?.user?.id ?? null,
			sessionUserEmail: token?.session?.user?.email ?? null,
		})
	) {
		const destination = new URLSearchParams({
			purchaseId: purchase.id,
			buyPathId: session_id,
			buyPathWaited: ready ? '1' : '0',
		})
		return redirect('/welcome?' + destination)
	}

	// Session-only authority: an anonymous post-purchase visitor sees no
	// transfer management until the signed purchase capability lands (AIH-223).
	const purchaseUserTransfers = await getPurchaseTransferForPurchaseId({
		id: purchase.id,
	})
	const seats = (count: number, more: boolean) => (
		<>
			Your purchase is for <strong className="text-foreground">{count}</strong>
			{more ? ' additional' : ''} seat{count > 1 && 's'}. You can always add
			more seats later when your team grows.
		</>
	)
	let eyebrow = 'Thank you for purchasing'
	let name =
		stripeProductName || product?.name || process.env.NEXT_PUBLIC_SITE_TITLE
	let description: React.ReactElement | null = null
	let withLoginLink = false
	let withInviteTeam = true

	switch (purchaseType) {
		case NEW_INDIVIDUAL_PURCHASE:
			withLoginLink = true
			withInviteTeam = false
			break
		case NEW_BULK_COUPON:
			description = seats(seatsPurchased, false)
			withLoginLink = true
			break
		case EXISTING_BULK_COUPON:
		case INDIVIDUAL_TO_BULK_UPGRADE:
			eyebrow = 'More seats added to'
			name = product?.name || process.env.NEXT_PUBLIC_SITE_TITLE || name
			description = seats(seatsPurchased, true)
			break
	}
	return (
		<PostPurchaseShell
			step={withLoginLink ? 'email' : 'ready'}
			paymentConfirmed
			readyWasShown={ready}
		>
			<PostPurchaseArrival
				destination="login_link"
				checkoutSessionId={session_id}
				purchaseWasPolled={ready}
			/>
			<PurchaseCard>
				<PurchaseCardSection>
					<PurchaseHeading
						artwork={purchaseArtwork(product)}
						badge={
							withLoginLink ? null : (
								<PostPurchaseIconBadge kind="ready" size="sm" play={!ready} />
							)
						}
						eyebrow={eyebrow}
						title={name}
					>
						{description ? (
							<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
								{description}
							</p>
						) : null}
					</PurchaseHeading>
				</PurchaseCardSection>
				{withInviteTeam ? (
					<PurchaseCardSection>
						<PurchaseInviteTeam purchase={purchase} disabled={!redemptionsLeft} />
					</PurchaseCardSection>
				) : null}
				{withLoginLink ? (
					<PurchaseCardSection>
						<PostPurchaseLoginLink
							email={email}
							supportEmail={env.NEXT_PUBLIC_SUPPORT_EMAIL}
						/>
					</PurchaseCardSection>
				) : null}
			</PurchaseCard>
			<PurchaseRows>
				<PurchaseInvoiceRow
					purchase={{ product: { name: stripeProductName }, ...purchase }}
					productName={stripeProductName}
				/>
				<PurchaseTransferRow
					onTransferInitiated={async () => {
						'use server'
						revalidatePath('/thanks/purchase')
					}}
					purchaseUserTransfers={purchaseUserTransfers}
					cancelPurchaseTransfer={cancelPurchaseTransfer}
					initiatePurchaseTransfer={initiatePurchaseTransfer}
				/>
			</PurchaseRows>
		</PostPurchaseShell>
	)
}
