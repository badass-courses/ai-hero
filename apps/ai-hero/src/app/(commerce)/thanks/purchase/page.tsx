import * as React from 'react'
import { Suspense } from 'react'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { PostPurchaseShell } from '../../_components/post-purchase-shell'
import { PostPurchaseArrival } from '../../_components/post-purchase-arrival'
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
import { FileText, Mail } from 'lucide-react'
import { PurchaseStatusPoller } from './purchase-status-poller'

import * as InvoiceTeaser from '@coursebuilder/commerce-next/invoices/invoice-teaser'
import * as LoginLink from '@coursebuilder/commerce-next/post-purchase/login-link'
import * as PurchaseSummary from '@coursebuilder/commerce-next/post-purchase/purchase-summary'
import * as PurchaseTransfer from '@coursebuilder/commerce-next/post-purchase/purchase-transfer'
import * as InviteTeam from '@coursebuilder/commerce-next/team/invite-team'
import {
	EXISTING_BULK_COUPON,
	INDIVIDUAL_TO_BULK_UPGRADE,
	NEW_BULK_COUPON,
	NEW_INDIVIDUAL_PURCHASE,
} from '@coursebuilder/core/schemas/purchase-type'

export const maxDuration = 100

const LoginLinkComp: React.FC<{ email: string }> = ({ email }) => {
	return (
		<LoginLink.Root email={email} className="border-b pb-5">
			<LoginLink.Status />
			<LoginLink.Title />
			<LoginLink.CTA className="mt-4 inline-flex items-center gap-3">
				<div className="bg-primary/20 text-primary flex h-10 w-10 items-center justify-center rounded-full p-3">
					<Mail className="h-4 w-4" />
				</div>
				<span>
					Login link sent to: <strong className="font-semibold">{email}</strong>
				</span>
			</LoginLink.CTA>
			<LoginLink.Description className="text-sm opacity-75 sm:text-base" />
		</LoginLink.Root>
	)
}

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
	let description: React.ReactElement | null = null
	let title = `Thank you for purchasing ${stripeProductName}`
	let loginLink: React.ReactElement | null = null
	let inviteTeam: React.ReactElement | null = (
		<InviteTeam.Root
			disabled={!redemptionsLeft}
			purchase={purchase}
			className="flex flex-col gap-y-2"
		>
			<InviteTeam.SeatsAvailable className="[&_span]:font-semibold" />
			<p>Send the following invite link to your colleagues to get started:</p>
			<div className="flex items-center gap-2">
				<InviteTeam.InviteLink />
				<InviteTeam.CopyInviteLinkButton />
			</div>
			<p>You'll be able to claim a seat for yourself once you sign in.</p>
		</InviteTeam.Root>
	)

	switch (purchaseType) {
		case NEW_INDIVIDUAL_PURCHASE:
			loginLink = <LoginLinkComp email={email} />
			inviteTeam = null
			break
		case NEW_BULK_COUPON:
			description = (
				<>
					Your purchase is for <strong>{seatsPurchased}</strong> seat
					{seatsPurchased > 1 && 's'}. You can always add more seats later when
					your team grows.
				</>
			)
			loginLink = <LoginLinkComp email={email} />
			break
		case EXISTING_BULK_COUPON:
			title = `Thank you for purchasing more seats for ${
				product?.name || process.env.NEXT_PUBLIC_SITE_TITLE
			}!`
			description = (
				<>
					Your purchase is for <strong>{seatsPurchased}</strong> additional seat
					{seatsPurchased > 1 && 's'}. You can always add more seats later when
					your team grows.
				</>
			)

			break
		case INDIVIDUAL_TO_BULK_UPGRADE:
			title = `Thank you for purchasing more seats for ${
				product?.name || process.env.NEXT_PUBLIC_SITE_TITLE
			}!`
			description = (
				<>
					Your purchase is for <strong>{seatsPurchased}</strong> additional seat
					{seatsPurchased > 1 && 's'}. You can always add more seats later when
					your team grows.
				</>
			)

			break
	}
	return (
		<PostPurchaseShell step={loginLink ? 'email' : 'ready'} paymentConfirmed>
			<PostPurchaseArrival
				destination="login_link"
				checkoutSessionId={session_id}
				purchaseWasPolled={ready}
			/>
			<div className="flex w-full flex-col gap-5">
				<PurchaseSummary.Root
					title={title}
					description={description}
					product={product}
					email={email}
				>
					<div className="flex flex-col items-center gap-10 sm:flex-row">
						<PurchaseSummary.ProductImage />
						<div className="flex w-full flex-col items-start">
							<PurchaseSummary.Status />
							<PurchaseSummary.Title />
							<PurchaseSummary.Description />
						</div>
					</div>
				</PurchaseSummary.Root>
				{inviteTeam && (
					<div className="border-b pb-5">
						<h2 className="text-primary pb-4 text-sm uppercase">Invite Team</h2>
						{inviteTeam}
					</div>
				)}
				{loginLink && loginLink}
				<div className="border-b pb-5">
					<h2 className="text-primary pb-4 text-sm uppercase">Invoice</h2>
					<InvoiceTeaser.Root
						className="flex w-full flex-row items-center justify-between sm:gap-10"
						purchase={{ product: { name: stripeProductName }, ...purchase }}
					>
						<InvoiceTeaser.Link className="flex w-full flex-col justify-between sm:flex-row sm:items-center">
							<InvoiceTeaser.Title className="inline-flex items-center gap-2">
								<FileText className="h-4 w-4 opacity-75" />
								<span className="underline">{stripeProductName}</span>
							</InvoiceTeaser.Title>
							<InvoiceTeaser.Metadata />
						</InvoiceTeaser.Link>
						<InvoiceTeaser.Link className="text-primary flex shrink-0 hover:underline" />
					</InvoiceTeaser.Root>
				</div>
				<div>
					<PurchaseTransfer.Root
						onTransferInitiated={async () => {
							'use server'
							revalidatePath('/thanks/purchase')
						}}
						purchaseUserTransfers={purchaseUserTransfers}
						cancelPurchaseTransfer={cancelPurchaseTransfer}
						initiatePurchaseTransfer={initiatePurchaseTransfer}
					>
						<PurchaseTransfer.Header />
						<PurchaseTransfer.Available>
							<PurchaseTransfer.Description />
							<PurchaseTransfer.Form>
								<PurchaseTransfer.InputLabel />
								<PurchaseTransfer.InputEmail />
								<PurchaseTransfer.SubmitButton />
							</PurchaseTransfer.Form>
						</PurchaseTransfer.Available>
						<PurchaseTransfer.Initiated>
							<PurchaseTransfer.Description />
							<PurchaseTransfer.Cancel />
						</PurchaseTransfer.Initiated>
						<PurchaseTransfer.Completed>
							<PurchaseTransfer.Description />
						</PurchaseTransfer.Completed>
					</PurchaseTransfer.Root>
				</div>
			</div>
		</PostPurchaseShell>
	)
}
