import * as React from 'react'
import { CldImage } from '@/components/cld-image'

/**
 * Slim quote break between homepage sections. Deliberately the SAME prop
 * shape as [[draft-testimonial.tsx#DraftTestimonial]] (`authorName`,
 * `authorAvatar`, children) so CMS authors learn one API and can swap one for
 * the other without rewriting the tag.
 *
 * Differences from `DraftTestimonial`, which stays as-is for the Rauch quote:
 * no stars, smaller type, half the vertical padding. It punctuates a scroll,
 * it does not stop it.
 */
export function TestimonialDivider({
	authorName,
	authorAvatar,
	children,
}: {
	authorName: string
	authorAvatar?: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border flex flex-col items-center gap-5 border-b px-8 py-12 sm:px-16">
			<blockquote className="max-w-3xl text-balance text-center font-sans text-xl font-medium not-italic leading-snug tracking-tight sm:text-2xl">
				{children}
			</blockquote>
			<div className="flex items-center gap-2.5">
				{authorAvatar && authorAvatar.includes('res.cloudinary') ? (
					<CldImage
						alt={authorName}
						width={32}
						height={32}
						className="rounded-full"
						src={authorAvatar}
					/>
				) : null}
				<span className="text-muted-foreground text-sm">{authorName}</span>
			</div>
		</section>
	)
}
