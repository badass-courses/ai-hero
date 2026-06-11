'use client'

import * as React from 'react'
import Link from 'next/link'
import { CldImage } from '@/components/cld-image'
import { AnimatedArrowCircle } from '@/components/landing/animated-arrow-circle'
import type { TypesenseResource } from '@/lib/typesense'
import { format } from 'date-fns'
import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { Highlight } from 'react-instantsearch'

import { Badge } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

const MotionLink = motion.create(Link)

export default function Hit({ hit }: { hit: TypesenseResource }) {
	const href = getResourceHref(hit)
	const dateLabel = hit.created_at_timestamp
		? format(new Date(hit.created_at_timestamp), 'MMM d, y')
		: ''
	const typeLabel = [humanizeType(hit.type), dateLabel]
		.filter(Boolean)
		.join(' · ')
	const isGeneratedImage = hit.image ? isGeneratedArtwork(hit.image) : false

	return (
		<li>
			<MotionLink
				href={href}
				prefetch
				initial="initial"
				whileHover="hover"
				animate="initial"
				className="border-border group relative -mt-px block border-y"
			>
				<motion.div
					aria-hidden
					className="animate-resource-gradient pointer-events-none absolute -inset-y-px inset-x-0"
					style={{
						backgroundImage:
							'linear-gradient(90deg, oklch(0.92 0.05 30), oklch(0.74 0.18 50), oklch(0.82 0.12 350), oklch(0.50 0.20 260), oklch(0.85 0.10 5), oklch(0.92 0.07 145), oklch(0.74 0.18 50), oklch(0.88 0.18 95), oklch(0.62 0.22 25), oklch(0.74 0.18 45), oklch(0.82 0.12 350), oklch(0.92 0.05 30))',
						backgroundSize: '200% 200%',
					}}
					variants={{
						initial: { opacity: 0 },
						hover: { opacity: 1 },
					}}
					transition={{ duration: 0.4, ease: [0.65, 0, 0.35, 1] }}
				/>
				<motion.div
					aria-hidden
					className="bg-background pointer-events-none absolute"
					variants={{
						initial: { top: 0, right: 0, bottom: 0, left: 0 },
						hover: { top: 5, right: 5, bottom: 5, left: 5 },
					}}
					transition={{ duration: 0.4, ease: [0.65, 0, 0.35, 1] }}
				/>
				<div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-8 sm:px-14 sm:py-10">
					<div
						className={cn(
							'relative aspect-video w-full shrink-0 overflow-hidden sm:w-60',
							hit.image ? 'bg-muted' : 'bg-stripes',
						)}
					>
						{hit.image ? (
							<>
								<CldImage
									src={hit.image}
									alt={hit.title}
									fill
									deliveryType={isRemoteUrl(hit.image) ? 'fetch' : undefined}
									sizes="(min-width: 640px) 240px, 100vw"
									className="object-cover transition-transform duration-500 ease-in-out group-hover:scale-105"
								/>
								{/* {isGeneratedImage && (
									<span
										className="bg-background/80 text-foreground absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm"
										title="AI-generated cover"
									>
										<Sparkles className="h-3 w-3" aria-hidden />
										AI
									</span>
								)} */}
							</>
						) : (
							<span className="absolute inset-0 flex items-center justify-center px-3 text-center font-mono text-xs font-semibold uppercase tracking-widest opacity-30">
								{humanizeType(hit.type)}
							</span>
						)}
					</div>
					<div className="flex flex-1 flex-col gap-2.5">
						{typeLabel && (
							<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								{typeLabel}
							</span>
						)}
						<h3 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
							<Highlight
								attribute="title"
								hit={hit as any}
								classNames={{
									highlighted: 'bg-primary text-primary-foreground',
								}}
							/>
						</h3>
						{hit.summary && (
							<div className="text-balance text-sm leading-relaxed opacity-80 sm:text-base">
								<Highlight
									attribute="summary"
									hit={hit as any}
									classNames={{
										highlighted: 'bg-primary text-primary-foreground',
										nonHighlighted: 'text-muted-foreground',
									}}
								/>
							</div>
						)}
						{hit?.tags && hit.tags.length > 0 && (
							<div className="mt-1 flex flex-wrap items-center gap-1">
								{hit.tags.map((tag) => (
									<Badge
										key={tag.id}
										variant="outline"
										className="text-muted-foreground rounded-full text-xs opacity-75"
									>
										# {tag.fields?.label || tag.fields?.name}
									</Badge>
								))}
							</div>
						)}
					</div>
					<div className="hidden sm:block">
						<AnimatedArrowCircle />
					</div>
				</div>
			</MotionLink>
		</li>
	)
}

function getResourceHref(hit: TypesenseResource) {
	if (hit.type === 'solution') {
		const parentLesson = hit.parentResources?.find(
			(p) => p.type === 'lesson' || p.type === 'exercise',
		)
		const parentWorkshop = hit.parentResources?.find(
			(p) =>
				p.type === 'workshop' || p.type === 'list' || p.type === 'tutorial',
		)

		if (parentLesson && parentWorkshop) {
			return getResourcePath(hit.type, parentLesson.slug, 'view', {
				parentSlug: parentWorkshop.slug,
				parentType: parentWorkshop.type,
			})
		}
	}

	return getResourcePath(hit.type, hit.slug, 'view')
}

function capitalize(s: string) {
	return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

const TYPE_LABELS: Record<string, string> = {
	'dictionary-entry': 'Dictionary',
	dictionary: 'Dictionary',
}

function humanizeType(type: string) {
	return TYPE_LABELS[type] ?? capitalize(type)
}

function isRemoteUrl(value: string) {
	return /^https?:\/\//i.test(value) && !/res\.cloudinary\.com/i.test(value)
}

function isGeneratedArtwork(url: string) {
	return /\/post-artwork\//i.test(url)
}
