'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { EyeIcon } from '@heroicons/react/24/outline'

import { cn } from '@coursebuilder/ui/utils/cn'

import { TYPE } from './type'
import { VideoThumbnailPreview } from './video-thumbnail-preview'

export function ResourceCard({
	title,
	href,
	image,
	muxPlaybackId,
	thumbnailTime,
	formatLabel,
}: {
	title: string
	href: string
	image?: string
	muxPlaybackId?: string
	thumbnailTime?: number
	/** "Video · 12 min", "Video", or "Article". Built by `buildFormatLabel`. */
	formatLabel?: string
}) {
	const isExternal = /^https?:\/\//i.test(href)

	return (
		<Link
			href={href}
			prefetch={!isExternal}
			target={isExternal ? '_blank' : undefined}
			rel={isExternal ? 'noopener noreferrer' : undefined}
			className="group flex h-full flex-col"
		>
			<div
				className={cn(
					'relative aspect-video w-full overflow-hidden rounded-[10px]',
					image ? 'bg-muted' : 'bg-stripes',
				)}
			>
				{muxPlaybackId && image ? (
					<VideoThumbnailPreview
						thumbnailUrl={image}
						muxPlaybackId={muxPlaybackId}
						title={title}
						thumbnailTime={thumbnailTime}
					/>
				) : image ? (
					<Image
						src={image}
						alt={title}
						fill
						className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
						sizes="(min-width: 768px) 33vw, 100vw"
					/>
				) : (
					<span className="absolute inset-0 flex items-center justify-center font-mono text-4xl font-semibold uppercase tracking-widest">
						<EyeIcon className="size-10 text-neutral-400 dark:text-neutral-500" />
					</span>
				)}
			</div>
			<div className="flex flex-col gap-[7px] pt-[13px]">
				{formatLabel ? (
					<span
						className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}
					>
						{formatLabel}
					</span>
				) : null}
				<h3
					className={cn(
						TYPE.bodyTight,
						'group-hover:text-primary text-balance tracking-[-0.012em] transition-colors',
					)}
				>
					{title}
				</h3>
			</div>
		</Link>
	)
}
