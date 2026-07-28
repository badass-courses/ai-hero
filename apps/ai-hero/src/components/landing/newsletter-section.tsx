import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

import { TYPE } from './type'

/**
 * The page's one newsletter ask (`Home Page.dc.html` § MATT + NEWSLETTER).
 *
 * It is a PANEL, not a section: a bordered card that sits inside the column it
 * belongs to. The homepage used to make the ask twice — a full-width block
 * mid-page and a slim strip at the end — which is the same offer at two
 * volumes, and neither of them was next to the person making it. The prototype
 * makes it once, in Matt's column, directly under his bio: the pitch and the
 * face are one unit.
 *
 * Pass it to `AboutMatt`'s `newsletter` slot rather than rendering it as a
 * sibling section.
 */
export function NewsletterSection({
	heading,
	subTitle,
	className,
	children,
}: {
	/** ReactNode for the same reason as `subTitle`: the heading can carry a
	 *  live `<SubscriberCount />` ("Join 98,000+ developers"). */
	heading?: React.ReactNode
	/**
	 * ReactNode, not string, so the CMS body can drop a live element in here:
	 * `subTitle={<>Join over <SubscriberCount /> developers…</>}`. Subscriber
	 * counts must never be hardcoded (they go stale the week they are written).
	 */
	subTitle?: React.ReactNode
	className?: string
	children: React.ReactNode
}) {
	return (
		<section
			className={cn(
				'border-border rounded-lg border bg-[color:var(--ah-band)] px-6 py-6 sm:px-7 sm:py-[26px]',
				className,
			)}
		>
			{heading && (
				<h2
					className={cn(
						TYPE.panelTitle,
						'mb-1.5 text-balance font-sans',
					)}
				>
					{heading}
				</h2>
			)}
			{subTitle && (
				<p
					className={cn(
						TYPE.metaProse,
						'mb-5 max-w-[52ch] text-pretty text-[color:var(--ah-fg-muted)]',
					)}
				>
					{subTitle}
				</p>
			)}
			{children}
		</section>
	)
}
