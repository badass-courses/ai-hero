import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { isOnEmailList } from '@/lib/cta-gating'
import {
	getSubscriberForGating,
	hasKnownReaderIdentity,
} from '@/lib/subscriber-gate'

import { cn } from '@coursebuilder/ui/utils/cn'

import { ListNewsletterForm } from './list-newsletter-form'

/** The shell shared by the real cell and its placeholder, so the two cannot
 *  drift apart. */
function Cell({ children }: { children: React.ReactNode }) {
	return (
		<div className="bg-muted flex flex-col gap-4 px-[18px] py-16 sm:px-11 md:py-20">
			{children}
		</div>
	)
}

/**
 * "Keep learning" — the second cell of the overview's closing two-up.
 *
 * Suspended by the page so a list route keeps its prerendered shell: this is
 * the only part of the page that depends on who is reading, and awaiting that
 * in the page body took the whole route out of static generation.
 *
 * Returns null for a subscriber, and the section's `auto-fit` grid gives the
 * remaining cell the full row. The page used to close by offering someone who
 * subscribed months ago a form to subscribe again.
 */
export async function ListClosingNewsletter() {
	// Same reasoning as `PostClosingNewsletter`: a Suspense fallback covers
	// pending, not rejected, so an exception here would escape to the route's
	// error boundary and trade the whole overview for one cell of it. Degrade to
	// showing the ask instead.
	let subscriber = null
	try {
		subscriber = await getSubscriberForGating()
	} catch {
		subscriber = null
	}

	if (isOnEmailList(subscriber)) return null

	return (
		<Cell>
			{/* No eyebrow: "Keep learning" restated the heading below it. */}
			<h2 className={cn(TYPE.subhead, 'text-balance')}>
				New lessons the day they land
			</h2>
			<ListNewsletterForm
				knownIdentity={await hasKnownReaderIdentity(subscriber)}
			/>
		</Cell>
	)
}

/**
 * Holds the cell's shape while the reader is resolved — same surface, same
 * padding, same three blocks at the same heights, so the real form arriving
 * moves nothing for the majority who are not yet subscribed.
 */
export function ListNewsletterCellSkeleton() {
	return (
		<Cell>
			<div aria-hidden className="flex animate-pulse flex-col gap-4">
				<div className="bg-foreground/10 h-3 w-28 rounded-[4px]" />
				<div className="bg-foreground/10 h-6 w-3/4 max-w-[22ch] rounded-[4px]" />
				<div className="flex w-full max-w-[460px] flex-col gap-3">
					<div className="flex flex-col gap-3 desk:flex-row">
						<div className="bg-foreground/10 h-12 w-full rounded-[9px] desk:h-11" />
						<div className="bg-foreground/10 h-12 w-full rounded-[9px] desk:h-11" />
					</div>
					<div className="bg-foreground/10 h-12 w-full rounded-[9px] desk:h-11" />
					<div className="bg-foreground/10 h-3 w-44 rounded-[4px]" />
				</div>
			</div>
		</Cell>
	)
}
