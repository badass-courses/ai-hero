import * as React from 'react'
import Link from 'next/link'
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
 * With no related items the newsletter cell simply spans the row.
 */
export function PostRelatedNewsletter({
	items,
	heading = 'Related reading',
	trackParams,
	id,
	className,
}: {
	items: PostRelatedItem[]
	heading?: string
	/** Merged into the `subscribed` track call, e.g. `{ post, location }`. */
	trackParams?: Record<string, string>
	/** Scroll target, so the ToC rail can list this block. */
	id?: string
	className?: string
}) {
	const hasRelated = items.length > 0

	return (
		<section
			id={id}
			aria-label="Related reading and newsletter"
			// No border of its own: the article container draws the rule above every
			// section (see the note on `<article>` in `[post]/page.tsx`), so a local
			// one would double up against it.
			className={cn(
				'border-border bg-border grid grid-cols-1 gap-px',
				// See the pager: a jump target has to clear the sticky header.
				id && 'scroll-mt-(--nav-height)',
				hasRelated && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
				className,
			)}
		>
			{hasRelated && (
				<div className="bg-background px-[18px] py-10 sm:px-11">
					<h2
						className={cn(TYPE.micro, 'mb-5 text-[color:var(--ah-fg-label)]')}
					>
						{heading}
					</h2>
					<ul className="flex flex-col gap-2.5">
						{items.map((item) => (
							<li key={item.id}>
								<Link
									href={`/${item.slug}`}
									className="border-input hover:border-foreground/25 focus-visible:ring-ring group flex items-center gap-4 rounded-md border px-4 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2"
								>
									<span className="min-w-0">
										<span
											className={cn(
												TYPE.micro,
												'mb-1.5 block text-[color:var(--ah-fg-label)]',
											)}
										>
											{item.meta}
										</span>
										<span
											className={cn(TYPE.bodyTight, 'block text-pretty')}
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
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="flex flex-col bg-[color:var(--ah-band)] px-[18px] py-10 sm:px-11">
				<p className={cn(TYPE.micro, 'mb-4 text-[color:var(--ah-fg-label)]')}>
					Keep learning
				</p>
				<h2 className={cn(TYPE.panelTitle, 'mb-2 text-balance')}>
					Join <SubscriberCount /> developers
				</h2>
				<p
					className={cn(
						TYPE.metaProse,
						'mb-[18px] max-w-[44ch] text-pretty text-[color:var(--ah-fg-muted)]',
					)}
				>
					New skills and Matt's AI coding letters, the day they land.
				</p>
				<PostNewsletterForm trackParams={trackParams} />
			</div>
		</section>
	)
}
