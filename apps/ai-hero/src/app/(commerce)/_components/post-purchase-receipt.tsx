import * as React from 'react'
import {
	TransferDenialMessage,
	TransferDenialRoot,
} from '@/purchase-transfer/transfer-denial-form'
import { Icon } from '@/components/brand/icons'
import { TYPE } from '@/components/landing/type'
import { ArrowUpRight, ChevronDown, Copy, Users } from 'lucide-react'

import * as InvoiceTeaser from '@coursebuilder/commerce-next/invoices/invoice-teaser'
import * as PurchaseTransfer from '@coursebuilder/commerce-next/post-purchase/purchase-transfer'
import * as InviteTeam from '@coursebuilder/commerce-next/team/invite-team'
import type { Purchase, PurchaseUserTransfer } from '@coursebuilder/core/schemas'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	PURCHASE_GHOST_BUTTON,
	PurchaseNextStep,
	PurchaseRow,
} from './post-purchase-parts'

/**
 * The receipt rows and the team step, dressed for this site around the
 * commerce kit's own parts. Every link, form and action is the kit's: only
 * the layout and the words around them are ours.
 */

const FIELD =
	'border-input bg-background text-foreground h-10 min-w-0 rounded-[9px] border px-3 text-sm placeholder:text-[color:var(--ah-fg-faint)]'

export function PurchaseInvoiceRow({
	purchase,
	productName,
}: {
	purchase: Purchase
	productName?: string | null
}) {
	return (
		<InvoiceTeaser.Root purchase={purchase}>
			<PurchaseRow
				label="Invoice"
				action={
					<InvoiceTeaser.Link className={PURCHASE_GHOST_BUTTON}>
						View invoice
					</InvoiceTeaser.Link>
				}
			>
				<p>
					{productName ? `${productName} · ` : null}
					<InvoiceTeaser.Amount /> · <InvoiceTeaser.IssueDate />
				</p>
			</PurchaseRow>
		</InvoiceTeaser.Root>
	)
}

export function PurchaseTransferRow({
	purchaseUserTransfers,
	initiatePurchaseTransfer,
	cancelPurchaseTransfer,
	onTransferInitiated,
}: {
	purchaseUserTransfers: PurchaseUserTransfer[]
	initiatePurchaseTransfer: React.ComponentProps<
		typeof PurchaseTransfer.Root
	>['initiatePurchaseTransfer']
	cancelPurchaseTransfer: React.ComponentProps<
		typeof PurchaseTransfer.Root
	>['cancelPurchaseTransfer']
	onTransferInitiated: () => Promise<void>
}) {
	if (!purchaseUserTransfers?.length) return null
	return (
		<TransferDenialRoot
			onTransferInitiated={onTransferInitiated}
			purchaseUserTransfers={purchaseUserTransfers}
			cancelPurchaseTransfer={cancelPurchaseTransfer}
			initiatePurchaseTransfer={initiatePurchaseTransfer}
		>
			<PurchaseTransfer.Available>
				{/* Rarely needed, so it waits behind its row until asked for. */}
				<details className="group">
					<summary className="flex cursor-pointer list-none flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8 [&::-webkit-details-marker]:hidden">
						<span className="flex min-w-0 flex-col gap-1">
							<span className={TYPE.cardTitle}>Transfer to another email</span>
							<span className={cn(TYPE.metaProse, 'text-muted-foreground')}>
								Bought it with a work address, or for someone else?
							</span>
						</span>
						<span className={cn(PURCHASE_GHOST_BUTTON, 'shrink-0 self-start')}>
							Transfer
							<ChevronDown
								aria-hidden="true"
								className="size-4 transition-transform duration-300 group-open:rotate-180 motion-reduce:transition-none"
							/>
						</span>
					</summary>
					<div className={cn(TYPE.metaProse, 'text-muted-foreground flex flex-col gap-4 pb-5')}>
						<p className="max-w-[60ch]">
							You can move this purchase to another email address once. Use a
							personal address you will keep. After the transfer, this account
							loses access to the course and its invoices.
						</p>
						<PurchaseTransfer.Form className="mt-0 flex w-full flex-col gap-2 sm:flex-row md:flex-row">
							<PurchaseTransfer.InputLabel />
							<PurchaseTransfer.InputEmail className={cn(FIELD, 'flex-1')} />
							<PurchaseTransfer.SubmitButton
								className={cn(PURCHASE_GHOST_BUTTON, 'shadow-none')}
							/>
						</PurchaseTransfer.Form>
						<TransferDenialMessage />
					</div>
				</details>
			</PurchaseTransfer.Available>
			<PurchaseTransfer.Initiated>
				<PurchaseRow
					label="Transfer in progress"
					action={
						<PurchaseTransfer.Cancel
							className={cn(
								PURCHASE_GHOST_BUTTON,
								'text-destructive mt-0 shadow-none',
							)}
						/>
					}
				>
					<p>
						Once it is accepted, this account no longer has access to the course
						or its invoice. You can cancel any time before it is accepted or
						expires.
					</p>
				</PurchaseRow>
			</PurchaseTransfer.Initiated>
			<PurchaseTransfer.Completed>
				<PurchaseRow label="Transferred">
					<p>
						This purchase now belongs to another email address. This account
						no longer has access to it or its invoice.
					</p>
				</PurchaseRow>
			</PurchaseTransfer.Completed>
		</TransferDenialRoot>
	)
}

/**
 * Seats for the team: how many are left and the link that hands them out.
 * `canClaim` adds the buyer's own seat, which needs a session.
 */
export function PurchaseInviteTeam({
	purchase,
	existingPurchase,
	userEmail,
	disabled,
	canClaim = false,
}: {
	purchase: Purchase
	existingPurchase?: Purchase | null
	userEmail?: string | null
	disabled: boolean
	canClaim?: boolean
}) {
	return (
		<InviteTeam.Root
			disabled={disabled}
			purchase={purchase}
			existingPurchase={existingPurchase}
			userEmail={userEmail}
		>
			<PurchaseNextStep
				icon={
					<span
						aria-hidden="true"
						className="bg-muted text-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-full"
					>
						<Users className="size-4" />
					</span>
				}
				title="Invite your team"
			>
				<InviteTeam.SeatsAvailable className="[&_span]:text-foreground [&_span]:font-semibold" />
				<p>Send this link to your colleagues so they can claim a seat.</p>
			</PurchaseNextStep>
			<div className="mt-4 flex flex-col gap-2 sm:flex-row sm:pl-14">
				<label htmlFor="inviteLink" className="sr-only">
					Invite link
				</label>
				<InviteTeam.InviteLink className={cn(FIELD, 'flex-1 font-mono text-[13px]')} />
				{/* The kit's button drops `className`, so it lends its handler to ours. */}
				<InviteTeam.CopyInviteLinkButton asChild>
					<button type="button" aria-label="Copy link" className={PURCHASE_GHOST_BUTTON}>
						<Copy className="size-4" aria-hidden="true" />
						Copy link
					</button>
				</InviteTeam.CopyInviteLinkButton>
			</div>
			<div className="mt-3 sm:pl-14">
				{canClaim ? (
					// The kit puts `className` on a wrapper and swaps its label while
					// claiming, so the button is styled from the wrapper.
					<InviteTeam.SelfRedeemButton className="items-start [&>button]:border-input [&>button]:text-foreground [&>button]:hover:bg-foreground/[0.04] [&>button]:h-10 [&>button]:w-auto [&>button]:rounded-[9px] [&>button]:bg-transparent [&>button]:px-4 [&>button]:text-sm [&>button]:font-bold [&>button]:shadow-none" />
				) : (
					<p className={cn(TYPE.metaSm, 'text-muted-foreground')}>
						You can claim a seat for yourself once you sign in.
					</p>
				)}
			</div>
		</InviteTeam.Root>
	)
}

/** Shares the product's own page; the site's home when there is none. */
export function PurchaseShareRow({
	productName,
	productPath,
}: {
	productName: string
	productPath?: string | null
}) {
	const site = process.env.NEXT_PUBLIC_URL
	const url = site ? new URL(productPath ?? '', site).toString() : ''
	const text = `${productName} ${url}`.trim()
	return (
		<PurchaseRow
			label="Share"
			action={
				<a
					href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`}
					target="_blank"
					rel="noopener noreferrer"
					className={PURCHASE_GHOST_BUTTON}
				>
					<Icon name="X" size="16" />
					Share on X
					<ArrowUpRight className="size-3.5" aria-hidden="true" />
				</a>
			}
		>
			<p>
				Tell your friends about {process.env.NEXT_PUBLIC_SITE_TITLE ?? productName}.
				It helps get the word out.
			</p>
		</PurchaseRow>
	)
}
