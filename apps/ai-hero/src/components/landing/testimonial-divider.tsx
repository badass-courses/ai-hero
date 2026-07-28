import * as React from 'react'
import { CldImage } from '@/components/cld-image'

/**
 * Slim quote break between homepage sections. Same prop shape as
 * [[draft-testimonial.tsx#DraftTestimonial]] (`authorName`, `authorAvatar`,
 * children) so CMS authors learn one API.
 *
 * The problem this solves: as centered text on `bg-background` at the page's
 * body measure, a quote is indistinguishable from the centered intro
 * paragraphs it sits between. Four things make it read as testimony instead:
 *
 * 1. **Its own surface.** `bg-muted/30` between two `border-y` rules, so the
 *    band is visibly inset from the sections above and below rather than
 *    being more page.
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
		<section className="border-border bg-muted/30 border-y">
			<figure className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-8 py-14 text-center sm:px-16 md:py-16">
				<span
					aria-hidden
					className="text-foreground/20 -mb-10 text-8xl font-medium leading-none"
				>
					&ldquo;
				</span>
				<blockquote className="text-balance text-xl font-medium italic leading-snug tracking-tight sm:text-2xl">
					{children}
				</blockquote>
				<figcaption className="flex items-center gap-3">
					{authorAvatar && authorAvatar.includes('res.cloudinary') ? (
						<CldImage
							alt={name}
							width={44}
							height={44}
							className="rounded-full"
							src={authorAvatar}
						/>
					) : null}
					<span className="flex flex-col items-start text-left leading-tight">
						<span className="text-foreground text-sm font-semibold">{name}</span>
						{title ? (
							<span className="text-muted-foreground text-sm">{title}</span>
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
function splitAttribution(
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
