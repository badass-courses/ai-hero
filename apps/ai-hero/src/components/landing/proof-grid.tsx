import * as React from 'react'
import { CldImage } from '@/components/cld-image'

import { CompanyLogoGrid } from './company-logo-grid'
import { splitAttribution } from './testimonial-divider'
import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The page's proof, in one place (`Home Page.dc.html` § PROOF).
 *
 * The homepage used to spend its testimonials one at a time — a quote beside
 * the newsletter, a quote between two sections, a starred quote near the
 * bottom — which meant no two of them were ever read together. Three names a
 * reader recognises, side by side under one label, is an argument; the same
 * three spread over four screens is decoration.
 *
 * Set as a hairline grid inset in the gutter, like the skills panel: a slab of
 * evidence sitting ON the band rather than three more page sections.
 */
export function ProofGrid({
	eyebrow = 'What people say',
	logosEyebrow = 'Trusted by engineers from',
	children,
}: {
	eyebrow?: string
	/** The label on the company band that closes the section. */
	logosEyebrow?: string
	children: React.ReactNode
}) {
	const quotes = React.Children.toArray(children)

	return (
		<section
			aria-label={eyebrow}
			className="border-border border-b bg-[color:var(--ah-band)] px-[18px] pb-8 pt-14 sm:px-11 sm:pb-[30px] sm:pt-16"
		>
			<p className={cn(TYPE.micro, 'mb-8 text-[color:var(--ah-fg-label)]')}>
				{eyebrow}
			</p>
			<ul className="border-border bg-border grid grid-cols-1 gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
				{quotes.map((quote, i) => (
					<li
						key={i}
						className="bg-background flex flex-col px-[26px] py-[30px]"
					>
						{quote}
					</li>
				))}
				{Array.from({ length: smFillerCount(quotes.length) }).map((_, i) => (
					<li
						key={`sm-filler-${i}`}
						aria-hidden
						className="bg-background hidden sm:block lg:hidden"
					/>
				))}
				{Array.from({ length: lgFillerCount(quotes.length) }).map((_, i) => (
					<li
						key={`lg-filler-${i}`}
						aria-hidden
						className="bg-background hidden lg:block"
					/>
				))}
			</ul>
			{/* The company band belongs to PROOF, not to the tail of the page
			    (`Home Page.dc.html` § PROOF): names you recognise and logos you
			    recognise are one argument, and the prototype closes the block with
			    them on a single hairline-topped row. */}
			{/* No rule above the logos: the quote grid directly overhead already
			    ends on its own hairline, so a second one right under it read as a
			    doubled divider with a sliver of band trapped between. The spacing
			    does the separating. */}
			<CompanyLogoGrid
				variant="row"
				eyebrow={logosEyebrow}
				className="mt-6 pb-[22px] pt-[26px]"
			/>
		</section>
	)
}

/**
 * Empty cells so the trailing hairline stays clean, counted per breakpoint —
 * the grid is 1 / 2 / 3 across and each width has its own short last row.
 *
 * Counting only the 3-across remainder left the usual three quotes with an
 * unpainted cell beside the third one between `sm` and `lg`: the grid's own
 * `bg-border` shows through anywhere a cell fails to paint, so that gap read
 * as a solid half-width block of rule colour rather than a hairline.
 * `TopicsGrid` has carried the two-count version of this from the start.
 */
function smFillerCount(count: number): number {
	return count % 2 === 0 ? 0 : 1
}

function lgFillerCount(count: number): number {
	const remainder = count % 3
	return remainder === 0 ? 0 : 3 - remainder
}

/**
 * One quote. Same `authorName` / `authorAvatar` API as `TestimonialDivider`
 * and `DraftTestimonial`, so a CMS author learns one shape for all three.
 */
export function ProofQuote({
	authorName,
	authorTitle,
	authorAvatar,
	children,
}: {
	authorName: string
	/** Falls back to the part after an em dash in `authorName`. */
	authorTitle?: string
	authorAvatar?: string
	children: React.ReactNode
}) {
	const { name, title } = splitAttribution(authorName, authorTitle)

	return (
		<figure className="flex h-full flex-col">
			{/* Curly quotation marks come from the component, not the copy
			    (`Home Page.dc.html` § PROOF). A CMS author typing straight quotes,
			    or none, still gets the prototype's typography. */}
			<blockquote
				className={cn(
					TYPE.quote,
					// Full-strength ink, not the body ramp: a testimonial is the loudest
					// thing in its cell. `text-inherit` needs `!` because `.ah-prose-p`
					// sets its colour from an UNLAYERED rule, which outranks any layered
					// utility no matter the specificity (see globals.css § ARTICLE PROSE).
					'text-foreground mb-5 text-pretty [&_p]:m-0! [&_p]:text-inherit!',
					'[&>p]:before:content-["“"] [&>p]:after:content-["”"]',
				)}
			>
				{children}
			</blockquote>
			<figcaption className="mt-auto flex items-center gap-[11px]">
				{authorAvatar && authorAvatar.includes('res.cloudinary') ? (
					<CldImage
						alt={name}
						width={34}
						height={34}
						className="size-[34px] shrink-0 rounded-full object-cover"
						src={authorAvatar}
					/>
				) : null}
				<span className="flex flex-col items-start text-left leading-tight">
					<span className={cn(TYPE.metaSm, 'text-foreground font-medium')}>
						{name}
					</span>
					{title ? (
						<span
							className={cn(TYPE.metaSm, 'text-[color:var(--ah-fg-subtle)]')}
						>
							{title}
						</span>
					) : null}
				</span>
			</figcaption>
		</figure>
	)
}
