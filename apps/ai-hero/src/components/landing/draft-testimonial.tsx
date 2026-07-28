import * as React from 'react'
import { CldImage } from '@/components/cld-image'
import { Star } from 'lucide-react'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

export function DraftTestimonial({
	authorName,
	authorAvatar,
	children,
}: {
	authorName: string
	authorAvatar?: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border flex flex-col items-center gap-8 border-b px-8 py-20 sm:px-16">
			<div aria-hidden className="flex items-center gap-1 text-[#ffcf77]">
				{Array.from({ length: 5 }).map((_, i) => (
					<Star key={i} className="h-5 w-5 fill-[#ffcf77]" />
				))}
			</div>
			<blockquote className={cn(TYPE.subhead, 'text-balance text-center font-sans not-italic')}>
				{children}
			</blockquote>
			<div className="flex items-center gap-3">
				{authorAvatar && authorAvatar.includes('res.cloudinary') ? (
					<CldImage
						alt={authorName}
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
				<span className="text-base opacity-80">{authorName}</span>
			</div>
		</section>
	)
}
