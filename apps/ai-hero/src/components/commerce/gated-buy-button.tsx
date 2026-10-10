'use client'

import * as React from 'react'
import { env } from '@/env.mjs'
import {
	purchaseGate,
	type PurchaseGate,
} from '@/lib/c5-pricing/purchasability'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

/** The current product's purchase gate, from the pricing context. */
export function usePurchaseGate(): PurchaseGate {
	const { formattedPrice } = Pricing.usePricing()
	return purchaseGate(formattedPrice)
}

/**
 * Says when the price shown is an upper bound, not the buyer's price. Renders
 * nothing for a chargeable price.
 */
export function UpperBoundNote({ className }: { className?: string }) {
	const gate = usePurchaseGate()
	if (!gate.upperBound) return null
	return (
		<p
			className={cn('text-muted-foreground text-center text-sm', className)}
			data-upper-bound=""
		>
			{gate.kind === 'sign-in'
				? 'Up to this price. Sign in to see yours.'
				: 'Up to this price.'}
		</p>
	)
}

/** Where a regional ticket holder asks for unrestricted access. */
export const regionalUpgradeHref = () =>
	`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}?subject=${encodeURIComponent(
		'Upgrade my regional ticket',
	)}`

/**
 * What a buyer who holds a region-restricted ticket sees instead of Buy Now.
 * There is no self-serve upgrade; support upgrades the ticket.
 */
export function RegionalUpgradeSupport({
	className,
	label = 'Contact support to upgrade',
}: {
	className?: string
	label?: string
}) {
	return (
		<div className="flex w-full flex-col items-center gap-2">
			<p className="text-muted-foreground text-center text-sm">
				You have a regional ticket. Support can upgrade it to full access.
			</p>
			<a
				className={cn(
					'bg-primary text-primary-foreground flex h-14 w-full items-center justify-center rounded px-4 py-4 text-center text-base font-medium',
					className,
				)}
				href={regionalUpgradeHref()}
				data-purchase-gate="support"
			>
				{label}
			</a>
		</div>
	)
}

/**
 * `Pricing.BuyButton`, disabled when the authoritative decision has no
 * purchasable price. The stock button only knows pending, error and sold out.
 */
export function GatedBuyButton({
	className,
	children,
	asChild,
}: {
	className?: string
	children?: React.ReactNode
	asChild?: boolean
}) {
	const gate = usePurchaseGate()
	if (gate.kind === 'support')
		return <RegionalUpgradeSupport className={className} label={gate.label} />
	if (gate.kind === 'blocked') {
		return (
			<>
				<UpperBoundNote className="mb-2" />
				<Button
					className={cn(
						'bg-primary text-primary-foreground flex h-14 w-full items-center justify-center rounded px-4 py-4 text-center text-base font-medium disabled:cursor-not-allowed disabled:opacity-50',
						className,
					)}
					type="button"
					size="lg"
					disabled
					data-purchase-gate="blocked"
				>
					{gate.label}
				</Button>
			</>
		)
	}
	if (gate.kind === 'sign-in') {
		return (
			<>
				<UpperBoundNote className="mb-2" />
				<Pricing.BuyButton className={className} asChild={asChild}>
					{gate.label}
				</Pricing.BuyButton>
			</>
		)
	}
	return (
		<Pricing.BuyButton className={className} asChild={asChild}>
			{children}
		</Pricing.BuyButton>
	)
}
