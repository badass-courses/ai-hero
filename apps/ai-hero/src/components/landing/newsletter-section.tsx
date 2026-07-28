import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

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
	 * Tighter treatment for a SECOND ask on the same page. The first newsletter
	 * bar is the real pitch and keeps full height; repeating that scale after
	 * the posts grid reads as shouting the same thing twice.
	 */
	compact?: boolean
	children: React.ReactNode
}) {
	return (
		<section className="border-border relative flex flex-col items-center border-b">
			<div
				className={cn(
					'flex w-full max-w-4xl flex-col items-center px-8 sm:px-16',
					compact ? 'gap-6 py-10 md:py-12' : 'gap-8 py-16 md:py-20',
				)}
			>
				<div className="flex flex-col items-center gap-2.5">
					{heading && (
						<h2
							className={cn(
								'text-balance text-center font-sans font-semibold leading-tight tracking-tight',
								compact ? 'text-xl sm:text-2xl' : 'text-3xl sm:text-4xl',
							)}
						>
							{heading}
						</h2>
					)}
					{subTitle && (
						<p
							className={cn(
								'text-balance text-center font-sans font-normal leading-snug opacity-80',
								compact ? 'text-sm sm:text-base' : 'text-base sm:text-lg',
							)}
						>
							{subTitle}
						</p>
					)}
				</div>
				{children}
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
