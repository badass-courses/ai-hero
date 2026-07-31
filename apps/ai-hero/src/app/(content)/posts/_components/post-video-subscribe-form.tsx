'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { isOnEmailList } from '@/lib/cta-gating'
import { Subscriber } from '@/schemas/subscriber'
import common from '@/text/common'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/utils/cn'

type PrimaryNewsletterCtaProps = {
	onSuccess?: () => void
	title?: React.ReactNode
	byline?: React.ReactNode
	actionLabel?: string
	id?: string
	className?: string
	trackProps?: {
		event?: string
		params?: Record<string, string>
	}
}

export const PostNewsletterCta: React.FC<
	React.PropsWithChildren<PrimaryNewsletterCtaProps>
> = ({
	children,
	className,
	id = 'post-newsletter-cta',
	title = common['primary-newsletter-tittle'],
	byline = common['primary-newsletter-byline'],
	actionLabel = common['primary-newsletter-button-cta-label'],
	trackProps = { event: 'subscribed', params: {} },
	onSuccess,
}) => {
	const router = useRouter()
	const { subscriber } = useCtaGate()

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (subscriber) {
			track(trackProps.event as string, trackProps.params)
			const redirectUrl = redirectUrlBuilder(subscriber, '/confirm')
			router.push(redirectUrl)
		}
	}

	// Only the resolved answer suppresses this. It used to wait for a mount
	// effect AND for the query, rendering nothing in between — so the ask
	// appeared a beat after the page settled, shoving the content under it
	// down. That cost was paid by everyone the ask is FOR (non-subscribers,
	// the overwhelming majority) to spare a group who could simply be given
	// nothing once we know who they are.
	//
	// Rendering it first and removing it on resolve is the better trade: the
	// only movement left belongs to people who turn out to be subscribed, and
	// it happens once.
	if (isOnEmailList(subscriber)) {
		return null
	}

	return (
		<section
			aria-label="Newsletter sign-up"
			className={cn(
				'bg-muted relative flex w-full flex-row items-center border-t',
				className,
			)}
		>
			<div className="relative mx-auto flex w-full flex-col items-stretch">
				<div
					className="via-muted-foreground/20 bg-linear-to-r absolute -top-px left-0 z-10 h-px w-1/2 from-transparent to-transparent"
					aria-hidden="true"
				/>
				<div
					className="via-muted-foreground/20 bg-linear-to-r absolute -bottom-px left-0 z-10 h-px w-full from-transparent to-transparent"
					aria-hidden="true"
				/>
				<div className="flex flex-col items-center gap-1 px-5 py-4 text-center md:items-start md:px-3 md:text-left">
					<div className="font-heading text-balance text-lg font-semibold leading-tight md:text-xl">
						{title}
					</div>
					<div className="dark:text-primary font-heading text-muted-foreground text-balance text-sm leading-snug md:text-base">
						{byline}
					</div>
				</div>
				<div id={id} className="w-full border-t">
					<SubscribeToConvertkitForm
						onSuccess={onSuccess ? onSuccess : handleOnSuccess}
						actionLabel={actionLabel}
						className="[&_input]:border-0"
					/>
				</div>
			</div>
		</section>
	)
}
