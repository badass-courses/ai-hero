import * as React from 'react'
import Image from 'next/image'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

/** 16:9 artwork beside the purchase's name; stripes stand in for none. */
export function PurchaseArtwork({ src }: { src?: string | null }) {
	return (
		<div className="border-border bg-stripes relative aspect-video w-32 shrink-0 overflow-hidden rounded-[6px] border sm:w-40">
			{src ? (
				<Image
					src={src}
					alt=""
					fill
					sizes="160px"
					className="object-cover motion-safe:animate-in motion-safe:fade-in"
				/>
			) : null}
		</div>
	)
}

/**
 * The purchase card: what was bought on top, what to do next below it, split
 * by the soft in-card rule. Every post-purchase screen leads with one.
 */
export function PurchaseCard({
	children,
	className,
}: {
	children: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				'border-input bg-card text-card-foreground flex flex-col rounded-[12px] border [&>*+*]:border-t [&>*+*]:border-[color:var(--ah-line-soft)]',
				className,
			)}
		>
			{children}
		</div>
	)
}

export function PurchaseCardSection({
	children,
	className,
}: {
	children: React.ReactNode
	className?: string
}) {
	return <div className={cn('p-5 sm:p-6', className)}>{children}</div>
}

/**
 * Artwork, an eyebrow and the page's one `h1`. `badge` leads the eyebrow:
 * the ready tick, once access is set up.
 */
export function PurchaseHeading({
	artwork,
	badge,
	eyebrow,
	title,
	children,
}: {
	artwork?: string | null
	badge?: React.ReactNode
	eyebrow: React.ReactNode
	title: React.ReactNode
	children?: React.ReactNode
}) {
	return (
		<div className="flex flex-col items-start gap-4 sm:flex-row sm:gap-6">
			<PurchaseArtwork src={artwork} />
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<p className={cn(TYPE.eyebrow, 'mb-0 flex items-center gap-2')}>
					{badge}
					{eyebrow}
				</p>
				<h1 className={cn(TYPE.panelTitle, 'text-balance')}>{title}</h1>
				{children}
			</div>
		</div>
	)
}

/** One step the buyer can take, with a badge or icon in front. */
export function PurchaseNextStep({
	icon,
	title,
	children,
	action,
}: {
	icon: React.ReactNode
	title: React.ReactNode
	children?: React.ReactNode
	action?: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
			<div className="flex min-w-0 items-start gap-4">
				{icon}
				<div className="flex min-w-0 flex-col gap-1 pt-0.5">
					<h2 className={TYPE.cardTitle}>{title}</h2>
					{children ? (
						<div className={cn(TYPE.metaProse, 'text-muted-foreground')}>
							{children}
						</div>
					) : null}
				</div>
			</div>
			{action ? <div className="shrink-0 sm:pl-0 pl-14">{action}</div> : null}
		</div>
	)
}

/**
 * The receipt under the card: invoice, transfer, sharing. Rows sit on the
 * page, divided by the light section rule, so the card stays the one thing
 * that asks for attention.
 */
export function PurchaseRows({ children }: { children: React.ReactNode }) {
	return (
		<div className="border-border flex flex-col border-t [&>*]:border-b [&>*]:border-border">
			{children}
		</div>
	)
}

export function PurchaseRow({
	label,
	children,
	action,
	className,
}: {
	label: React.ReactNode
	children?: React.ReactNode
	action?: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				'flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8',
				className,
			)}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<h2 className={TYPE.cardTitle}>{label}</h2>
				{children ? (
					<div className={cn(TYPE.metaProse, 'text-muted-foreground')}>
						{children}
					</div>
				) : null}
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
		</div>
	)
}

const FOCUS =
	'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'

/** The quiet bordered button, as on the workshop pricing card. */
export const PURCHASE_GHOST_BUTTON = cn(
	TYPE.meta,
	FOCUS,
	'border-input text-foreground hover:bg-foreground/[0.04] inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[9px] border bg-transparent px-4 font-bold transition-colors disabled:pointer-events-none disabled:opacity-60',
)

/** The gold call to action, as on the cohort block. */
export const PURCHASE_PRIMARY_BUTTON = cn(
	TYPE.meta,
	FOCUS,
	'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover group inline-flex h-[46px] items-center justify-center gap-2 whitespace-nowrap rounded-[9px] px-6 font-bold transition',
)
