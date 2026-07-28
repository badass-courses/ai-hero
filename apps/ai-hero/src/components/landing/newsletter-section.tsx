import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

import { TYPE } from './type'

export function NewsletterSection({
	heading,
	subTitle,
	compact = false,
	children,
}: {
	/** ReactNode for the same reason as `subTitle`: the heading can carry a
	 *  live `<SubscriberCount />` ("Join 97,000+ developers"). */
	heading?: React.ReactNode
	/**
	 * ReactNode, not string, so the CMS body can drop a live element in here:
	 * `subTitle={<>Join over <SubscriberCount /> developers…</>}`. Subscriber
	 * counts must never be hardcoded (they go stale the week they are written).
	 */
	subTitle?: React.ReactNode
	/**
	 * A SECOND ask on the same page, laid out as one row: copy left, form
	 * right. The first newsletter bar is the real pitch and keeps full height;
	 * repeating that scale after the posts grid says the same thing twice at
	 * the same volume.
	 */
	compact?: boolean
	children: React.ReactNode
}) {
	return (
		<section className="border-border relative flex flex-col items-center border-b">
			<div
				className={cn(
					'flex w-full px-8 sm:px-16',
					compact
						? 'max-w-6xl flex-col items-start gap-6 py-10 md:flex-row md:items-center md:justify-between md:gap-12'
						: 'max-w-4xl flex-col items-center gap-8 py-16 md:py-20',
				)}
			>
				<div
					className={cn(
						'flex flex-col gap-2.5',
						compact ? 'items-start text-left' : 'items-center',
					)}
				>
					{heading && (
						<h2
							className={cn(
								'text-balance font-sans font-semibold leading-tight tracking-tight',
								compact
									? TYPE.subhead
									: cn(TYPE.heading, 'text-center'),
							)}
						>
							{heading}
						</h2>
					)}
					{subTitle && (
						<p
							className={cn(
								'text-balance font-sans leading-snug opacity-80',
								compact
									? 'text-sm sm:text-base'
									: 'text-center text-base',
							)}
						>
							{subTitle}
						</p>
					)}
				</div>
				<div className={cn(compact && 'w-full md:max-w-xl md:shrink-0')}>
					{children}
				</div>
			</div>
			{!compact && (
				<div
					aria-hidden
					className="h-1.5 w-full bg-[url('/landing/colorful-stripe.jpg')] bg-contain bg-center bg-no-repeat sm:h-3"
				/>
			)}
		</section>
	)
}
