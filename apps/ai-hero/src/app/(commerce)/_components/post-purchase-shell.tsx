'use client'

import * as React from 'react'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { PostPurchaseIconBadge } from './post-purchase-icon'
import styles from './post-purchase-motion.module.css'
import {
	PURCHASE_GHOST_BUTTON,
	PURCHASE_PRIMARY_BUTTON,
	PurchaseCard,
	PurchaseCardSection,
	PurchaseColumn,
	PurchaseHeading,
} from './post-purchase-parts'
import {
	PostPurchaseProgress,
	type PurchaseStep,
} from './post-purchase-progress'

/**
 * The frame every post-purchase screen shares, from the first poll to the
 * welcome page, so nothing jumps when one hands over to the next: the three
 * steps, one live region, then the screen's own card.
 *
 * The live region is screen-reader only and always mounted, so each change of
 * step is announced once. What it says is shown once on screen, in the place
 * that state gives it: a caption while waiting, the failure card, the tick in
 * the card's eyebrow when ready, the login-link step on the email screen.
 *
 * Changes of state happen in place: the caption folds away, the placeholder
 * heading crosses to the real one, and a full-page hand-over to the next
 * screen cross-fades where the browser supports it. After a hand-over
 * (`handover`) the card's heading is already on screen, so only what is
 * new settles in.
 */
export function PostPurchaseShell({
	step = 'processing',
	paymentConfirmed = false,
	handover = false,
	title,
	image,
	message,
	supportEmail,
	onRetry,
	children,
	landmark = 'main',
}: {
	step?: PurchaseStep
	paymentConfirmed?: boolean
	handover?: boolean
	title?: string
	image?: string | null
	message?: string
	supportEmail?: string
	onRetry?: () => void
	children?: React.ReactNode
	landmark?: 'main' | 'section'
}) {
	const Landmark = landmark
	const heading = React.useRef<HTMLHeadingElement>(null)
	React.useEffect(() => {
		if (step === 'failed') heading.current?.focus({ preventScroll: true })
	}, [step])
	const status =
		message ??
		{
			processing: 'Setting up your access. This usually takes a few seconds.',
			slow: 'Taking longer than usual. We are still waiting for your purchase to finish processing.',
			opening: 'Payment confirmed. Opening your purchase.',
			ready: 'Ready. Your access is set up.',
			email: 'One last step. Check your email for your login link.',
			failed:
				'We could not finish checking your access. Please check your email for a login link or contact support. Do not pay again.',
		}[step]
	const moving = step === 'processing' || step === 'slow'
	const working = moving || step === 'opening'
	// The caption is only ever built on a screen that waited, and it keeps its
	// last words while it folds away.
	const [caption, setCaption] = React.useState(moving ? status : null)
	if (moving && caption !== status) setCaption(status)
	// Only what changes in place animates: a caption or title that was already
	// there on the first paint is simply there.
	const [first] = React.useState({ caption, title })
	const placeholder = working ? 'ah-skeleton' : 'bg-foreground/10'
	// The tick is the welcome page's payoff: the hand-over before it claims
	// payment and access, never "ready", so the tick is always new when it shows.
	const readyBadge =
		step === 'ready' ? <PostPurchaseIconBadge kind="ready" size="sm" /> : null
	return (
		<LayoutClient withContainer>
			<Landmark
				data-handover={handover ? '' : undefined}
				className={cn(
					'min-h-[calc(100vh-var(--nav-height))]',
					children && styles.arrive,
				)}
			>
				<style>{CROSS_DOCUMENT_FADE}</style>
				<PurchaseColumn>
					<div className="flex flex-col">
						<PostPurchaseProgress step={step} paymentConfirmed={paymentConfirmed} />
						<p
							role="status"
							aria-live="polite"
							aria-atomic="true"
							className="sr-only"
						>
							{status}
						</p>
						{caption ? (
							<div aria-hidden="true" data-open={moving} className={styles.collapse}>
								<div>
									<p
										key={caption}
										className={cn(
											TYPE.metaProse,
											'text-muted-foreground pt-8 md:pt-10',
											caption !== first.caption && styles.swap,
										)}
									>
										{caption}
									</p>
									<div data-open={step === 'slow'} className={styles.collapse}>
										<div>
											<div className="pt-4">
												<div className="bg-foreground/[0.04] border-input flex flex-col gap-1 rounded-[11px] border px-5 py-4">
													<p className={TYPE.cardTitle}>Still setting up</p>
													<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
														You can leave this tab open while we check. If you
														already received a login link, you can use it to sign
														in.
													</p>
												</div>
											</div>
										</div>
									</div>
								</div>
							</div>
						) : null}
					</div>
					{step === 'failed' ? (
						<PurchaseCard>
							<PurchaseCardSection className="flex flex-col gap-3">
								<h1
									ref={heading}
									tabIndex={-1}
									className={cn(TYPE.panelTitle, 'outline-none')}
								>
									Setup needs a hand
								</h1>
								<p
									aria-hidden="true"
									className={cn(TYPE.metaProse, 'text-muted-foreground max-w-[52ch]')}
								>
									{status}
								</p>
								<div className="flex flex-wrap gap-3 pt-3">
									<button
										type="button"
										onClick={onRetry ?? (() => window.location.reload())}
										className={PURCHASE_PRIMARY_BUTTON}
									>
										Check again
									</button>
									<a
										href={`mailto:${supportEmail ?? 'support@aihero.dev'}`}
										className={cn(PURCHASE_GHOST_BUTTON, 'h-[46px] px-6')}
									>
										Contact support
									</a>
								</div>
							</PurchaseCardSection>
						</PurchaseCard>
					) : (
						(children ?? (
							<PurchaseCard className={title ? undefined : 'pointer-events-none'}>
								<PurchaseCardSection>
									<div className={styles.stack}>
										<div
											aria-hidden="true"
											className={cn(
												'flex flex-col items-start gap-4 sm:flex-row sm:gap-6',
												styles.fade,
												title && 'opacity-0',
											)}
										>
											<div
												className={cn(
													'aspect-video w-32 shrink-0 rounded-[6px] sm:w-40',
													placeholder,
												)}
											/>
											<div className="flex w-full flex-1 flex-col gap-3 pt-1">
												{readyBadge ? (
													<p className={cn(TYPE.eyebrow, 'mb-0 flex items-center gap-2')}>
														{readyBadge}
														Ready
													</p>
												) : (
													<div className={cn('h-3 w-24 rounded-[4px]', placeholder)} />
												)}
												<div className={cn('h-7 w-4/5 rounded-[6px]', placeholder)} />
											</div>
										</div>
										{title ? (
											<div className={cn(title !== first.title && styles.reveal)}>
												<PurchaseHeading
													artwork={image}
													badge={readyBadge}
													eyebrow={
														step === 'ready'
															? 'Ready'
															: step === 'opening'
																? 'Thank you for purchasing'
																: 'Your purchase'
													}
													title={title}
												/>
											</div>
										) : null}
									</div>
								</PurchaseCardSection>
								<PurchaseCardSection>
									<div aria-hidden="true" className="flex items-start gap-4">
										<div className={cn('size-10 shrink-0 rounded-full', placeholder)} />
										<div className="flex flex-1 flex-col gap-2.5 pt-1">
											<div className={cn('h-4 w-1/3 rounded-[4px]', placeholder)} />
											<div className={cn('h-4 w-2/3 rounded-[4px]', placeholder)} />
										</div>
									</div>
								</PurchaseCardSection>
							</PurchaseCard>
						))
					)}
				</PurchaseColumn>
			</Landmark>
		</LayoutClient>
	)
}

/**
 * Opts this screen into the browser's cross-document fade, so the waiting
 * screen's hand-over (a full reload with `ready=1`) and the redirect to the
 * welcome page dissolve instead of cutting. Both ends must opt in, and every
 * post-purchase screen renders this shell, so no other page is affected.
 */
const CROSS_DOCUMENT_FADE =
	'@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }'
