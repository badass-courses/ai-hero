'use client'

import * as React from 'react'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { PostPurchaseIconBadge } from './post-purchase-icon'
import {
	PURCHASE_GHOST_BUTTON,
	PURCHASE_PRIMARY_BUTTON,
	PurchaseCard,
	PurchaseCardSection,
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
 */
export function PostPurchaseShell({
	step = 'processing',
	paymentConfirmed = false,
	readyWasShown = false,
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
	readyWasShown?: boolean
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
			ready: 'Ready. Your access is set up.',
			email: 'One last step. Check your email for your login link.',
			failed:
				'We could not finish checking your access. Please check your email for a login link or contact support. Do not pay again.',
		}[step]
	const moving = step === 'processing' || step === 'slow'
	const placeholder = moving ? 'motion-reduce:animate-none' : 'animate-none'
	// The tick plays once, on the screen where access turned ready; a page the
	// poller handed over to shows it already drawn.
	const readyBadge =
		step === 'ready' ? (
			<PostPurchaseIconBadge kind="ready" size="sm" play={!readyWasShown} />
		) : null
	return (
		<LayoutClient withContainer>
			<Landmark className="min-h-[calc(100vh-var(--nav-height))]">
				<div className="mx-auto flex w-full max-w-[728px] flex-col gap-8 px-[18px] py-12 sm:px-11 md:gap-10 md:py-[72px]">
					<PostPurchaseProgress step={step} paymentConfirmed={paymentConfirmed} />
					<p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
						{status}
					</p>
					{moving ? (
						<div aria-hidden="true" className="flex flex-col gap-4">
							<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
								{status}
							</p>
							{step === 'slow' ? (
								<div className="bg-muted flex flex-col gap-1 rounded-[11px] px-5 py-4">
									<p className={TYPE.cardTitle}>Still setting up</p>
									<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
										You can leave this tab open while we check. If you already
										received a login link, you can use it to sign in.
									</p>
								</div>
							) : null}
						</div>
					) : null}
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
									<div aria-hidden={!title}>
										{title ? (
											<PurchaseHeading
												artwork={image}
												badge={readyBadge}
												eyebrow={step === 'ready' ? 'Ready' : 'Your purchase'}
												title={title}
											/>
										) : (
											<div className="flex flex-col items-start gap-4 sm:flex-row sm:gap-6">
												<div className="bg-stripes-muted border-border aspect-video w-32 shrink-0 rounded-[6px] border sm:w-40" />
												<div className="flex w-full flex-1 flex-col gap-3 pt-1">
													{readyBadge ? (
														<p className={cn(TYPE.eyebrow, 'mb-0 flex items-center gap-2')}>
															{readyBadge}
															Ready
														</p>
													) : (
														<Skeleton className={cn('h-3 w-24', placeholder)} />
													)}
													<Skeleton className={cn('h-7 w-4/5', placeholder)} />
												</div>
											</div>
										)}
									</div>
								</PurchaseCardSection>
								<PurchaseCardSection>
									<div aria-hidden="true" className="flex items-start gap-4">
										<Skeleton
											className={cn('size-10 shrink-0 rounded-full', placeholder)}
										/>
										<div className="flex flex-1 flex-col gap-2.5 pt-1">
											<Skeleton className={cn('h-4 w-1/3', placeholder)} />
											<Skeleton className={cn('h-4 w-2/3', placeholder)} />
										</div>
									</div>
								</PurchaseCardSection>
							</PurchaseCard>
						))
					)}
				</div>
			</Landmark>
		</LayoutClient>
	)
}
