import * as React from 'react'
import { CompleteOnNavigateLink } from '@/components/complete-on-navigate-link'
import { TYPE } from '@/components/landing/type'
import { SubscriberCount } from '@/components/subscriber-count'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { PostNewsletterForm } from './post-newsletter-form'

/** A row in the "Related reading" column. `meta` is the eyebrow line. */
export type PostRelatedItem = {
	id: string
	title: string
	slug: string
	/** "Article · 7 min read", or just "Article" when there is no duration. */
	meta: string
}

/**
 * The end of a post (`Skill Article Page.dc.html` § RELATED + NEWSLETTER).
 *
 * Related reading and the newsletter are ONE hairline grid, not two stacked
 * bands: the page used to close with a related-posts section, then a full-width
 * centred CTA, then a next-up card, which is three endings in a row. Here the
 * reader's two options — read another one, or hear about the next one — sit
 * side by side, the left cell on the page surface and the right on the band.
 *
 * With no related items the newsletter cell simply spans the row, and with no
 * newsletter the related cell does — either way the grid never renders a cell
 * that is only there to balance the other one.
 */
export function PostRelatedNewsletter({
	items,
	heading = 'Related reading',
	newsletter = null,
	id,
	className,
	completesResourceId,
}: {
	items: PostRelatedItem[]
	heading?: string
	/**
	 * When set, leaving through a related row marks this resource (the current
	 * post) complete. The caller sets it for posts that hold a POSITION in a
	 * list: at a list's finale this grid IS the closing navigation — there is no
	 * "next" pager to carry the write — so without it the last lesson stayed
	 * permanently unticked.
	 */
	completesResourceId?: string
	/**
	 * The newsletter cell, or null when the page has already asked for an email
	 * in the body.
	 *
	 * A SLOT rather than a boolean, because whether this cell renders is a fact
	 * about the reader — an existing subscriber gets nothing — and resolving
	 * that here would mean reading a cookie during this render and taking the
	 * whole article route out of static generation with it. The caller passes a
	 * suspended cell instead, so the shell is still prerendered and only the
	 * cell is decided per request.
	 *
	 * The grid takes its column count from how many children it actually has
	 * (see `auto-fit` below), so this may resolve to nothing without anyone
	 * having to tell the grid.
	 */
	newsletter?: React.ReactNode
	/** Scroll target, so the ToC rail can list this block. */
	id?: string
	className?: string
}) {
	const hasRelated = items.length > 0

	if (!hasRelated && !newsletter) return null

	return (
		<section
			id={id}
			// Deliberately NOT `newsletter ? …`. That slot is a React element — a
			// suspended cell — so it is truthy whether or not it ever renders
			// anything, and it renders nothing for a reader who already subscribed.
			// Testing it announced "and newsletter" to exactly the people who could
			// not find one.
			//
			// Naming only what is known at render time is the honest option: whether
			// the cell survives is decided per request, behind the boundary, after
			// this label is already written.
			aria-label="Related reading"
			// No border of its own: the article container draws the rule above every
			// section (see the note on `<article>` in `[post]/page.tsx`), so a local
			// one would double up against it.
			//
			// `auto-fit` is doing real work: the newsletter cell arrives after the
			// shell and may turn out to be nothing at all, so the column count
			// cannot be written down when this renders. auto-fit collapses the
			// empty track by itself — two cells split the row, one takes all of it
			// — which is exactly the "spread the survivor to full width" behaviour,
			// with no branch and nothing to keep in sync.
			className={cn(
				'border-border bg-border grid grid-cols-1 gap-px',
				// See the pager: a jump target has to clear the sticky header.
				id && 'scroll-mt-(--nav-height)',
				'md:grid-cols-[repeat(auto-fit,minmax(320px,1fr))]',
				className,
			)}
		>
			{hasRelated && (
				<div className="bg-background px-[18px] py-10 sm:px-11">
					<h2
						className={cn(TYPE.groupLabel, 'mb-5')}
					>
						{heading}
					</h2>
					<ul className="flex flex-col gap-2.5">
						{items.map((item) => (
							<li key={item.id}>
								<CompleteOnNavigateLink
									href={`/${item.slug}`}
									completesResourceId={completesResourceId}
									className="border-input hover:border-foreground/25 focus-visible:ring-ring group flex items-center gap-4 rounded-md border px-4 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2"
								>
									<span className="min-w-0">
										<span
											className={cn(
												TYPE.metaMark,
												'mb-1.5 block',
											)}
										>
											{item.meta}
										</span>
										{/* `cardTitle` (700), not `bodyTight` (500). These rows are
										    bordered cards and the title is the only thing in one a
										    reader is choosing between, so it should carry the same
										    weight as every other card title on the site — at 500 it
										    sat level with the prose it was competing against. */}
										<span
											className={cn(TYPE.cardTitle, 'block text-pretty')}
										>
											{item.title}
										</span>
									</span>
									{/* Opaque stroke dimmed by element opacity, NOT a
									    translucent stroke. `--ah-fg-faint` is the ink at 0.35
									    alpha, and lucide's arrow is two paths whose ends
									    overlap at the head — with alpha in the stroke the
									    overlap composites twice and the tip reads darker than
									    the shaft. Fading the whole shape once keeps it even.
									    Values match the token in both schemes. */}
									<ArrowRight
										aria-hidden
										className="ease-out-quart text-foreground ml-auto size-4 flex-none opacity-[0.35] transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none dark:opacity-30"
									/>
								</CompleteOnNavigateLink>
							</li>
						))}
					</ul>
				</div>
			)}
			{newsletter}
		</section>
	)
}

/** The shell both the real cell and its skeleton are poured into, so the
 *  placeholder cannot drift from the thing it is standing in for. */
function NewsletterCell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col bg-[color:var(--ah-band)] px-[18px] py-10 sm:px-11">
			{children}
		</div>
	)
}

/**
 * The newsletter half of the closing grid.
 *
 * Rendered by the caller inside a Suspense boundary, so an article route stays
 * prerenderable while this one cell is resolved per reader.
 */
export function PostNewsletterCell({
	trackParams,
	knownIdentity = false,
}: {
	/** Merged into the `subscribed` track call, e.g. `{ post, location }`. */
	trackParams?: Record<string, string>
	/** Server-resolved: this reader's address is already known, so the cell
	 *  offers one click instead of an email form. */
	knownIdentity?: boolean
}) {
	return (
		<NewsletterCell>
			{/* No eyebrow. "Keep learning" over "Join N developers" carried no fact
			    the heading does not already have. */}
			<h2 className={cn(TYPE.panelTitle, 'mb-2 text-balance')}>
				Join <SubscriberCount /> developers
			</h2>
			<p
				className={cn(
					TYPE.metaProse,
					'mb-[18px] max-w-[44ch] text-pretty text-[color:var(--ah-fg-muted)]',
				)}
			>
				New skills and Matt&rsquo;s AI coding letters, the day they land.
			</p>
			<PostNewsletterForm
				trackParams={trackParams}
				knownIdentity={knownIdentity}
			/>
		</NewsletterCell>
	)
}

/**
 * The placeholder that holds this cell's shape while the reader is resolved.
 *
 * Built to the real cell's measurements — same surface, same padding, same four
 * blocks at the same heights — because the point of it is that the arrival of
 * the real thing moves nothing. It is what the majority get: most readers are
 * not subscribed, so for most of them this is replaced by a form of exactly
 * these dimensions.
 *
 * A subscriber instead gets nothing here and the grid collapses to one column.
 * That is a real reflow, and it is the right one to accept: it happens to the
 * smaller group, at the very bottom of an article, below the fold, and the
 * alternative — holding an empty half-row open forever so the layout never
 * moves — is the dead space this whole change exists to remove.
 */
export function PostNewsletterCellSkeleton() {
	return (
		<NewsletterCell>
			{/* `aria-hidden`, and no `aria-busy`: a screen reader gains nothing from
			    being told a marketing cell is loading, and would be interrupted at
			    the end of the article to hear it. */}
			<div aria-hidden className="animate-pulse">
				<div className="bg-foreground/10 mb-4 h-3 w-24 rounded-[4px]" />
				<div className="bg-foreground/10 mb-2 h-7 w-3/4 rounded-[4px]" />
				<div className="bg-foreground/10 mb-[18px] h-4 w-full max-w-[44ch] rounded-[4px]" />
				<div className="flex w-full max-w-[520px] flex-col gap-2.5 desk:flex-row">
					<div className="bg-foreground/10 h-12 w-full rounded-[9px] desk:h-11" />
					<div className="bg-foreground/10 h-12 w-full rounded-[9px] desk:h-11" />
					<div className="bg-foreground/10 h-12 w-full rounded-[9px] desk:h-11 desk:w-28" />
				</div>
				<div className="bg-foreground/10 mt-3 h-3 w-48 rounded-[4px]" />
			</div>
		</NewsletterCell>
	)
}
