import * as React from 'react'
import { CldImage } from '@/components/cld-image'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

/**
 * Slim quote break between homepage sections. Same prop shape as
 * [[draft-testimonial.tsx#DraftTestimonial]] (`authorName`, `authorAvatar`,
 * children) so CMS authors learn one API.
 *
 * The problem this solves: as centered text on `bg-background` at the page's
 * body measure, a quote is indistinguishable from the centered intro
 * paragraphs it sits between. Four things make it read as testimony instead:
 *
 * 1. **Its own surface.** `bg-muted/30` closed by a `border-b`, so the
 *    band is visibly inset from the sections above and below rather than
 *    being more page. Laid out as a single short ROW (glyph · quote ·
 *    attribution) stacked tight and centred. Condensed, not tall: two of
 *    these punctuate the homepage, and at full height they read as sections
 *    in their own right and stall the scroll. The attribution stays directly
 *    under the quote — pushed to the far edge of a wide row it stops reading
 *    as "who said this".
 * 2. **A quotation mark as a typographic element**, large and low-contrast,
 *    the same move as the numerals in the skills showcase. It signals "someone
 *    said this" before a single word is read.
 * 3. **Italic, at a size the body copy never uses.** Italic is the one voice
 *    shift available without adding a typeface: DESIGN.md rule 10 documents
 *    exactly two families (Geist, Geist Mono), so reaching for a system serif
 *    here would introduce a third, unmanaged one.
 * 4. **Name and role split.** "Mario Zechner — creator of libGDX" as one flat
 *    string reads as a caption. Name in foreground, role muted underneath,
 *    reads as a person.
 *
 * `DraftTestimonial` stays the full-weight treatment (gold stars, larger type,
 * more air) for the Rauch quote, so the two never look interchangeable.
 */
export function TestimonialDivider({
	authorName,
	authorTitle,
	authorAvatar,
	compact = false,
	children,
}: {
	authorName: string
	/** Falls back to the part after an em dash in `authorName`. */
	authorTitle?: string
	authorAvatar?: string
	/**
	 * For a narrow column — inside a `SplitRow`, say. Steps the quote down from
	 * `subhead` to `bodyTight` and drops the surface tint. At full quote size in
	 * a third of the width the lines break every four or five words, which reads
	 * as a stack of fragments rather than a sentence.
	 */
	compact?: boolean
	children: React.ReactNode
}) {
	const { name, title } = splitAttribution(authorName, authorTitle)

	return (
		<section
			className={cn('border-border border-b', compact ? '' : 'bg-muted/30')}
		>
			<figure
				className={cn(
					'mx-auto flex flex-col items-center gap-4 text-center',
					compact ? 'max-w-md px-8 py-10' : 'max-w-3xl px-8 py-10 sm:px-16',
				)}
			>
				<span
					aria-hidden
					className={cn(
						'text-foreground/20 font-medium leading-none',
						compact ? '-mb-5 text-4xl' : '-mb-6 text-5xl',
					)}
				>
					&ldquo;
				</span>
				<blockquote
					className={cn(
						compact ? TYPE.bodyTight : TYPE.subhead,
						'text-balance italic',
					)}
				>
					{children}
				</blockquote>
				<figcaption className="flex items-center gap-3">
					{authorAvatar && authorAvatar.includes('res.cloudinary') ? (
						<CldImage
							alt={name}
							width={40}
							height={40}
							className="rounded-full"
							src={authorAvatar}
						/>
					) : null}
					<span className="flex flex-col items-start text-left leading-tight">
						<span className={cn(TYPE.meta, 'text-foreground font-semibold')}>{name}</span>
						{title ? (
							<span className={cn(TYPE.metaProse, 'text-muted-foreground')}>{title}</span>
						) : null}
					</span>
				</figcaption>
			</figure>
		</section>
	)
}

/**
 * "Mario Zechner — creator of libGDX" → name + role. Authors write one string
 * because that is what `Testimonial` takes; this keeps that API while still
 * letting the two parts be styled differently.
 */
export function splitAttribution(
	authorName: string,
	authorTitle?: string,
): { name: string; title?: string } {
	if (authorTitle) return { name: authorName, title: authorTitle }
	const [name, ...rest] = authorName.split(/\s+[—–-]\s+/)
	return {
		name: (name ?? authorName).trim(),
		title: rest.length > 0 ? rest.join(' — ').trim() : undefined,
	}
}
