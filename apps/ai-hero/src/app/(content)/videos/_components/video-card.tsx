'use client'

import * as React from 'react'
import { ResourceCard } from '@/components/landing/resource-card'
import { BADGE_OUTLINE, BADGE_SOLID, TYPE } from '@/components/landing/type'
import { env } from '@/env.mjs'
import type { TypesenseResource } from '@/lib/typesense'
import type { VideoViewerStatus } from '@/lib/video-viewer-status'
import { getResourcePath } from '@/utils/resource-paths'
import { Check } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * A /videos card: the homepage posts-grid card with YouTube-style inline
 * playback on hover (captions, sound once unmuted, progress), plus its runtime, whether you watched it, and — for a lesson — the
 * course it comes from. Everything here is a video the viewer can watch, so
 * there is no kind or price label; a free lesson from a course they do not
 * own is marked as the preview it is.
 */
export function VideoCard({
	hit,
	status,
}: {
	hit: TypesenseResource
	/** `null` until the viewer's status arrives; the card keeps its shape. */
	status: VideoViewerStatus | null
}) {
	const isLesson = hit.type === 'lesson'
	const watched = status?.watchedIds.includes(hit.id) ?? false
	const fromOwnedCourse =
		hit.course_ids?.some((id) => status?.ownedIds.includes(id)) ?? false
	// Free videos carry their playback in the index; a paid lesson's comes only
	// from the owner's status, since the index is publicly searchable. Neither
	// is needed for the still: `/api/thumbnails` resolves the video resource to
	// a Mux image server-side, so a card never needs a playback id to show one.
	const playbackId =
		hit.mux_playback_id ?? status?.playback[hit.id]?.playbackId
	const thumbnailTime = hit.thumbnail_time ?? 0
	const image =
		hit.image ??
		(hit.video_resource_id
			? // Absolute, like the lesson page's poster: next/image refuses a local
				// src with a query string unless images.localPatterns lists it.
				`${env.NEXT_PUBLIC_URL}/api/thumbnails?videoResourceId=${encodeURIComponent(hit.video_resource_id)}&time=${thumbnailTime}&width=720`
			: undefined)

	return (
		<ResourceCard
			title={hit.title}
			href={videoHref(hit)}
			image={image}
			muxPlaybackId={playbackId}
			thumbnailTime={thumbnailTime}
			inlinePlayback
			overlay={
				<>
					{watched && (
						<span
							className={cn(
								TYPE.badge,
								BADGE_SOLID,
								'pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1',
							)}
						>
							<Check className="size-3" aria-hidden />
							Watched
						</span>
					)}
					{hit.duration_seconds ? (
						<span
							className={cn(
								TYPE.metaMark,
								'bg-background/85 text-foreground pointer-events-none absolute bottom-2.5 right-2.5 rounded-[4px] px-1.5 py-0.5 tabular-nums backdrop-blur-sm',
							)}
						>
							{formatClock(hit.duration_seconds)}
						</span>
					) : null}
				</>
			}
			badges={
				isLesson && hit.free && !fromOwnedCourse ? (
					<span className={cn(TYPE.badge, BADGE_OUTLINE)}>Free preview</span>
				) : null
			}
			meta={
				isLesson && hit.container_title ? (
					<span className={TYPE.metaMark}>From {hit.container_title}</span>
				) : undefined
			}
		/>
	)
}

/** Lessons live under their workshop; alone they would route to a bare slug. */
function videoHref(hit: TypesenseResource) {
	if (hit.type === 'lesson') {
		const workshop = hit.parentResources?.find((p) => p.type === 'workshop')
		if (workshop) {
			return getResourcePath('lesson', hit.slug, 'view', {
				parentType: 'workshop',
				parentSlug: workshop.slug,
			})
		}
	}
	return getResourcePath(hit.type, hit.slug, 'view')
}

/** 754 → "12:34", 3723 → "1:02:03". */
function formatClock(seconds: number) {
	const total = Math.round(seconds)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const pad = (n: number) => String(n).padStart(2, '0')
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
