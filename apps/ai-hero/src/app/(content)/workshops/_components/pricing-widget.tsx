'use client'

import * as React from 'react'
import {
	ProductPricingFeatures,
	type ProductPricingFeature,
} from '@/components/commerce/product-pricing-features'
import { TYPE } from '@/components/landing/type'
import { formatDeadline } from '@/utils/discount-formatter'
import { ArrowUpRight, Mail, Minus, Plus, ShieldCheck } from 'lucide-react'
import type { CountdownRenderProps } from 'react-countdown'

import { useCoupon } from '@coursebuilder/commerce-next/coupons/use-coupon'
import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { usePriceCheck } from '@coursebuilder/commerce-next/pricing/pricing-check-context'
import { usePricing } from '@coursebuilder/commerce-next/pricing/pricing-context'
import type { Product, Purchase } from '@coursebuilder/core/schemas'
import type {
	CommerceProps,
	FormattedPrice,
	PricingOptions,
} from '@coursebuilder/core/types'
import { formatUsd } from '@coursebuilder/core/utils/format-usd'
import { Checkbox } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { WORKSHOP_CTA_BUTTON } from './workshop-notify-button'

export type PricingData = {
	formattedPrice?: FormattedPrice | null
	purchaseToUpgrade?: Purchase | null
	quantityAvailable: number
}

export type PricingWidgetProps = {
	product: Product
	quantityAvailable: number
	commerceProps: CommerceProps
	pricingDataLoader: Promise<PricingData>
	hasPurchasedCurrentProduct?: boolean
	pricingWidgetOptions?: Partial<PricingOptions>
	workshops?: {
		title: string
		slug: string
	}[]
	className?: string
	prependFeatures?: ProductPricingFeature[]
	/** Custom content for the buy button. Overrides default text based on product type. */
	buyButtonContent?: React.ReactNode
	/** Additional className for the buy button */
	buyButtonClassName?: string
	/** Hide the default product features section */
	hideFeatures?: boolean
	/** Custom buy button element. Rendered inside Pricing.Root so it can use pricing context. */
	buyButton?: React.ReactNode
	/** "/boss/<slug>" — a shareable approval letter, offered beside the team checkbox. */
	teamLetterHref?: string
}

/**
 * The workshop pricing card (`Workshop Landing.dc.html` § Sidebar, buy state):
 * a left-aligned column on `bg-card` — title, mono price with strikethrough and
 * a gold save-badge, team seats, the house gold CTA, guarantee line, countdown
 * box, regional-pricing box, and a check-list of what's included.
 *
 * All commerce behavior stays in the `Pricing.*` primitives (checkout form
 * action, coupon resolution, team quantity, PPP gating); this file only owns
 * how those facts look.
 */
export const PricingWidget = ({
	product,
	commerceProps,
	pricingDataLoader,
	pricingWidgetOptions,
	quantityAvailable: _quantityAvailable,
	workshops,
	className,
	prependFeatures,
	buyButtonContent,
	buyButtonClassName,
	hideFeatures,
	buyButton,
	teamLetterHref,
}: PricingWidgetProps) => {
	const couponFromCode = commerceProps?.couponFromCode
	const { validCoupon } = useCoupon(couponFromCode)
	const couponId =
		commerceProps?.couponIdFromCoupon ||
		(validCoupon ? couponFromCode?.id : undefined)

	return (
		<Pricing.Root
			className={cn('relative w-full items-stretch', className)}
			product={product}
			couponId={couponId}
			country={commerceProps.country}
			options={pricingWidgetOptions}
			userId={commerceProps?.userId}
			pricingDataLoader={pricingDataLoader}
			{...commerceProps}
		>
			<Pricing.Product className="w-full">
				<Pricing.Details className="w-full items-stretch px-5 pt-6 text-left sm:px-6">
					<Pricing.Name className="mt-0 px-0 text-left text-base font-bold tracking-[-0.018em] sm:text-base" />
					<Pricing.LiveQuantity className="mt-2 self-start" />
					{/* The primitive's wrapper centers its children by default; this card
					    is a left-aligned column, and the price skeleton has no width of
					    its own to disagree with. */}
					<Pricing.Price className="w-full items-start">
						<CardPrice
							isMembership={product.type === 'membership'}
							billingInterval={product.fields?.billingInterval}
						/>
					</Pricing.Price>
					<TeamPurchaseControls />
					{buyButton ?? (
						<Pricing.BuyButton
							className={cn(
								WORKSHOP_CTA_BUTTON,
								'mt-4 h-[46px] w-full',
								buyButtonClassName,
							)}
						>
							{buyButtonContent ??
								(product.type === 'cohort'
									? 'Enroll'
									: product.type === 'live'
										? 'Buy Ticket'
										: null)}
						</Pricing.BuyButton>
					)}
					<Pricing.GuaranteeBadge>
						<span
							className={cn(
								TYPE.metaSm,
								'text-muted-foreground mt-2.5 flex items-center justify-center gap-1.5',
							)}
						>
							<ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
							30-day money-back guarantee
						</span>
					</Pricing.GuaranteeBadge>
					<Pricing.SaleCountdown
						countdownRenderer={(props) => <SaleCountdownBox {...props} />}
					/>
					<Pricing.PPPToggle>
						<RegionalPricingBox />
					</Pricing.PPPToggle>
				</Pricing.Details>
			</Pricing.Product>
			{!hideFeatures && (
				<ProductPricingFeatures
					variant="checklist"
					className="mt-7 px-5 sm:px-6"
					workshops={workshops ?? []}
					productType={product.type}
					prependFeatures={prependFeatures}
				/>
			)}
			{teamLetterHref && (
				<div className="w-full px-5 pb-7 pt-5 sm:px-6">
					{/* The approval path, after the reader has seen what the money
					    buys: a ready-made letter to forward to whoever signs off.
					    Bordered like the card's other side-objects (countdown,
					    regional pricing) — an offer, not the ask, so no gold. New
					    tab, so the checkout they were considering stays put. */}
					<a
						href={teamLetterHref}
						target="_blank"
						rel="noopener noreferrer"
						className="border-border hover:bg-foreground/[0.04] group flex w-full items-start gap-3 rounded-[9px] border px-4 py-3.5 transition-colors"
					>
						<Mail
							className="text-muted-foreground mt-0.5 size-4 shrink-0"
							aria-hidden="true"
						/>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span
								className={cn(
									TYPE.meta,
									'text-foreground flex items-center gap-1 font-semibold',
								)}
							>
								Letter for your boss
								<ArrowUpRight
									className="size-3.5 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
									aria-hidden="true"
								/>
							</span>
							<span className={cn(TYPE.metaSm, 'text-muted-foreground')}>
								Need sign-off? Copy-paste the case for expensing this.
							</span>
						</span>
					</a>
				</div>
			)}
		</Pricing.Root>
	)
}

/**
 * Price row: mono numeral, and — under a discount — the struck full price and
 * a gold save-badge beside it. `calculatedPrice` is the checkout total (it
 * already carries team quantity), so what the row says is what the form
 * submits.
 */
const CardPrice = ({
	isMembership,
	billingInterval,
}: {
	isMembership: boolean
	billingInterval?: string | null
}) => {
	const { formattedPrice, status } = usePricing()
	const { isDiscount } = usePriceCheck()

	const fullPrice = formattedPrice?.fullPrice ?? 0
	const finalPrice = formattedPrice?.calculatedPrice ?? 0
	const discountActive = Boolean(formattedPrice && isDiscount(formattedPrice))
	const percentOff =
		discountActive && fullPrice > 0
			? Math.round(((fullPrice - finalPrice) / fullPrice) * 100)
			: 0
	const { dollars, cents } = formatUsd(finalPrice)

	// First load: no price to show yet, so hold the footprint of the WHOLE
	// block — the numeral line and the "one-time payment" caption under it,
	// at their exact heights and margins — so nothing below moves when the
	// number lands. `bg-foreground/10` rather than `bg-muted`, which is
	// invisible against the card's own ground in dark mode.
	if (status === 'pending' && !formattedPrice) {
		return (
			<div
				className="flex w-full flex-col items-start"
				aria-label="Loading price"
			>
				<div className="bg-foreground/10 mt-3 h-[38px] w-28 animate-pulse rounded-[6px] sm:h-[42px]" />
				{!isMembership && (
					<div className="bg-foreground/10 mt-1.5 h-[17px] w-24 animate-pulse rounded-[4px]" />
				)}
			</div>
		)
	}

	// A failed price lookup must not render as "$0" — the buy button is already
	// disabled in this state, so the row simply stays empty (same choice the
	// stock Price component makes).
	if (status === 'error' || !formattedPrice) {
		return null
	}

	// Refetch (team toggle, seat count, coupon): the known price stays put,
	// dimmed and pulsing, instead of collapsing into a skeleton — the reader
	// keeps their anchor and still sees that the number is in flight.
	const isRefetching = status === 'pending'

	return (
		<div className="flex w-full flex-col items-start">
			<div
				aria-live="polite"
				aria-busy={isRefetching}
				className={cn(
					'mt-3 flex flex-wrap items-baseline gap-2.5 transition-opacity',
					isRefetching && 'animate-pulse opacity-40',
				)}
			>
				<span className="font-mono text-[38px] font-medium leading-none tracking-[-0.03em] sm:text-[42px]">
					{dollars}
					{cents !== '00' && (
						<span className="text-[0.45em] align-super">.{cents}</span>
					)}
					{isMembership && (
						<span className="text-muted-foreground text-[0.4em]">
							{billingInterval === 'month' ? '/month' : '/year'}
						</span>
					)}
				</span>
				{discountActive && (
					<>
						<span
							aria-hidden="true"
							className="text-muted-foreground font-mono text-[15px] line-through"
						>
							{formatUsd(fullPrice).dollars}
						</span>
						<span
							aria-hidden="true"
							className={cn(
								TYPE.badge,
								'bg-accent-fill text-accent-fill-foreground rounded-[4px] px-[7px] py-[5px]',
							)}
						>
							Save {percentOff}%
						</span>
						<span className="sr-only">
							{percentOff}% off of {formatUsd(fullPrice).dollars}
						</span>
					</>
				)}
			</div>
			{!isMembership && (
				<span className={cn(TYPE.metaMark, 'mt-1.5')}>one-time payment</span>
			)}
		</div>
	)
}

/**
 * "Buying for your team?" — a checkbox where the old widget had a For myself /
 * For my team switch, and a bordered stepper where it had a bare number input.
 * Same context state underneath (`isTeamPurchaseActive`, `quantity`), so the
 * checkout path and PPP gating behave exactly as before.
 */
const TeamPurchaseControls = () => {
	const {
		isTeamPurchaseActive,
		toggleTeamPurchase,
		quantity,
		updateQuantity,
		setMerchantCoupon,
		isSoldOut,
		options: { teamQuantityLimit, allowTeamPurchase },
	} = usePricing()

	if (isSoldOut || !allowTeamPurchase) return null

	const clamp = (next: number) =>
		next < 1
			? 1
			: teamQuantityLimit && next > teamQuantityLimit
				? teamQuantityLimit
				: next

	const setQuantity = (next: number) => {
		if (!Number.isFinite(next)) return
		// A team quantity invalidates a regional coupon, same as the primitive's
		// own input does.
		setMerchantCoupon(undefined)
		updateQuantity(clamp(Math.trunc(next)))
	}

	const stepperButton =
		'border-border text-muted-foreground hover:bg-muted hover:text-foreground flex h-10 w-9 cursor-pointer items-center justify-center rounded-[9px] border transition-colors'

	return (
		<div className="mt-4 flex w-full flex-col items-start gap-3">
			{/* Sibling label via htmlFor, not a wrapping <label>: the Radix
			    checkbox renders a button, and a button inside a label is invalid
			    markup that leaves the control unnamed. */}
			<div className="flex items-center gap-2.5">
				<Checkbox
					id="team-purchase"
					checked={isTeamPurchaseActive}
					onCheckedChange={() => toggleTeamPurchase()}
					className="rounded-[4px]"
				/>
				<label
					htmlFor="team-purchase"
					className={cn(TYPE.meta, 'text-muted-foreground cursor-pointer')}
				>
					Buying for your team?
				</label>
			</div>
			{isTeamPurchaseActive && (
				<div className="flex items-center gap-2.5">
					<button
						type="button"
						aria-label="decrease seat quantity by one"
						className={stepperButton}
						onClick={() => setQuantity(quantity - 1)}
					>
						<Minus className="size-3.5" aria-hidden="true" />
					</button>
					<input
						type="number"
						inputMode="numeric"
						pattern="[0-9]*"
						min={1}
						max={teamQuantityLimit}
						step={1}
						required
						aria-label="Team seats"
						className="border-border bg-background h-10 w-[52px] rounded-[9px] border text-center font-mono text-[15px] font-medium [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						value={quantity}
						onChange={(e) => setQuantity(Number(e.target.value))}
						onKeyDown={(e) => {
							if (e.key === ',' || e.key === '.') e.preventDefault()
						}}
					/>
					<button
						type="button"
						aria-label="increase seat quantity by one"
						className={stepperButton}
						onClick={() => setQuantity(quantity + 1)}
					>
						<Plus className="size-3.5" aria-hidden="true" />
					</button>
					<span className={cn(TYPE.metaMark)}>
						{quantity === 1 ? '1 seat' : `${quantity} seats`}
					</span>
				</div>
			)}
		</div>
	)
}

/**
 * The countdown, as a quiet bordered box on the band ground instead of the old
 * "Hurry!" center-stage block. The deadline comes from the active coupon, so
 * the box only exists while a dated sale runs.
 */
const SaleCountdownBox = ({
	days,
	hours,
	minutes,
	seconds,
	completed,
}: CountdownRenderProps) => {
	const { formattedPrice } = usePricing()

	if (completed) return null

	const expires = formattedPrice?.defaultCoupon?.expires
	const deadline = formatDeadline(expires, 'short')
	const endsLabel = deadline ? `Price goes up ${deadline}` : 'Price goes up soon'
	const blocks: Array<[number, string]> = [
		[days, 'days'],
		[hours, 'hours'],
		[minutes, 'min'],
		[seconds, 'sec'],
	]

	return (
		<div className="border-border mt-7 w-full rounded-[9px] border bg-[color:var(--ah-band)] px-4 py-3.5">
			<div className={cn(TYPE.groupLabel, 'mb-2.5')}>{endsLabel}</div>
			<div aria-hidden="true" className="flex gap-[18px]">
				{blocks.map(([value, label]) => (
					<div key={label} className="flex flex-col gap-1">
						<span className={cn(TYPE.statSm)}>
							{String(value).padStart(2, '0')}
						</span>
						<span className={cn(TYPE.statLabel, 'mt-0')}>{label}</span>
					</div>
				))}
			</div>
			<span className="sr-only">
				{days} days, {hours} hours, {minutes} minutes, and {seconds} seconds
				remaining
			</span>
		</div>
	)
}

/**
 * Regional pricing (PPP) as one bordered sentence with a checkbox, replacing
 * the flag-image paragraph block. Visibility gating (coupon available, not a
 * team purchase, not an upgrade…) still lives in `Pricing.PPPToggle`; this is
 * only what shows once it applies. The from-country viewing restriction stays
 * in the copy — it is a condition of the discount, not decoration.
 */
const RegionalPricingBox = () => {
	const {
		formattedPrice,
		activeMerchantCoupon,
		setMerchantCoupon,
		pricingData: { purchaseToUpgrade },
	} = usePricing()

	const availablePPPCoupon = Array.isArray(formattedPrice?.availableCoupons)
		? formattedPrice.availableCoupons.find((coupon) => coupon?.type === 'ppp')
		: undefined
	const appliedPPPCoupon =
		activeMerchantCoupon?.type === 'ppp' ? activeMerchantCoupon : null

	const rawDiscount = availablePPPCoupon?.percentageDiscount as
		| string
		| number
		| { toNumber?: () => number }
		| undefined
	const percentOff = Math.floor(
		(typeof rawDiscount === 'string'
			? Number(rawDiscount)
			: typeof rawDiscount === 'number'
				? rawDiscount
				: (rawDiscount?.toNumber?.() ?? 0)) * 100,
	)

	// `Intl.DisplayNames.of` THROWS on a structurally invalid region code, and
	// the code here is stored coupon data — a bad row must not unmount the
	// whole pricing card.
	const rawCountryCode = availablePPPCoupon?.country || 'US'
	const countryCode = /^[A-Za-z]{2}$/.test(rawCountryCode)
		? rawCountryCode.toUpperCase()
		: 'US'
	const country =
		new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ??
		countryCode

	// Upgrading a PPP purchase auto-applies the coupon; a checkbox would only
	// invite unchecking it (same rule as the primitive's default UI).
	const hideCheckbox = Boolean(purchaseToUpgrade)

	return (
		<div className="border-border mt-3 w-full rounded-[9px] border px-4 py-3.5">
			{/* Sibling label via htmlFor — same rule as the team checkbox: the
			    Radix checkbox is a button and can't live inside a <label>. */}
			<div className="flex items-start gap-2.5">
				{!hideCheckbox && (
					<Checkbox
						id="regional-pricing"
						className="mt-0.5 rounded-[4px]"
						checked={Boolean(appliedPPPCoupon)}
						onCheckedChange={() => {
							if (appliedPPPCoupon) {
								setMerchantCoupon(undefined)
							} else {
								setMerchantCoupon(availablePPPCoupon as any)
							}
						}}
					/>
				)}
				<label
					htmlFor={hideCheckbox ? undefined : 'regional-pricing'}
					className={cn(
						TYPE.metaProse,
						'text-muted-foreground text-pretty',
						!hideCheckbox && 'cursor-pointer',
					)}
				>
					{/* Same voice as the team checkbox above: "Buying for your team?" /
					    "Buying from Czechia?" — the card's two questions rhyme. The
					    question and the offer both carry the emphasis; the conditions
					    stay muted. */}
					<strong className="text-foreground font-semibold">
						Buying from{' '}
						<span className="bg-foreground/10 mr-0.5 inline-block h-[14px] w-[18px] overflow-hidden align-[-2px]">
							{/* Fixed 18×14 box: the sentence holds its shape whether the
							    flag has loaded, is loading, or never arrives. */}
							<img
								src={`https://hardcore-golick-433858.netlify.app/image?code=${countryCode}`}
								alt=""
								width={18}
								height={14}
								loading="lazy"
								className="h-full w-full object-cover"
							/>
						</span>{' '}
						{country}?
					</strong>{' '}
					Activate{' '}
					<strong className="text-foreground font-semibold">
						{percentOff}% off
					</strong>{' '}
					with regional pricing. Content is then viewable from {country} only,
					and no bonuses are included.
				</label>
			</div>
		</div>
	)
}
