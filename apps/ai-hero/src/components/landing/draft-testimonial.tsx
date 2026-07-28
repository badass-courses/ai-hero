import * as React from 'react'
import { CldImage } from '@/components/cld-image'
import { Star } from 'lucide-react'

import { splitAttribution } from './testimonial-divider'
import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The full-weight testimonial, for the one quote that gets a section of its
 * own. It differs from [[testimonial-divider.tsx#TestimonialDivider]] by
 * ORNAMENT and SPACE — gold stars, a larger avatar, far more air — and by
 * nothing typographic. Same size step, same italic, same name-over-role
 * attribution, so the two read as one voice at two volumes rather than as two
 * unrelated components.
 *
 * No rules on it. This sits between the portrait above and the logo wall
 * below, and the three together read as one closing field — hairlines chop
 * that into three unrelated strips. `border-t-0!` opts out of the container
 * separator rule in `LandingBody`.
 */
export function DraftTestimonial({
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
		<section className="border-border flex flex-col items-center gap-8 border-t-0! px-8 py-20 sm:px-11">
			<div aria-hidden className="flex items-center gap-1 text-[#ffcf77]">
				{Array.from({ length: 5 }).map((_, i) => (
					<Star key={i} className="h-5 w-5 fill-[#ffcf77]" />
				))}
			</div>
			<blockquote className={cn(TYPE.subhead, 'text-balance text-center font-sans italic')}>
				{children}
			</blockquote>
			<div className="flex items-center gap-3">
				{authorAvatar && authorAvatar.includes('res.cloudinary') ? (
					<CldImage
						alt={name}
						width={48}
						height={48}
						className="rounded-full"
						src={authorAvatar}
					/>
				) : (
					<div
						aria-hidden
						className="bg-muted h-12 w-12 shrink-0 rounded-full"
					/>
				)}
				<span className="flex flex-col items-start text-left leading-tight">
					<span className={cn(TYPE.meta, 'text-foreground font-semibold')}>
						{name}
					</span>
					{title ? (
						<span className={cn(TYPE.metaProse, 'text-muted-foreground')}>
							{title}
						</span>
					) : null}
				</span>
			</div>
		</section>
	)
}
