'use client'

import * as React from 'react'
import { useMuxMetadata } from '@/hooks/use-mux-metadata'
import type { RestrictedVideoPayload } from '@/lib/restricted-video-access'
import MuxPlayer from '@mux/mux-player-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * A welcome video that only one organization's members can see, dropped into a
 * workshop body as `<TeamWelcomeVideo resourceId="..." />`.
 *
 * ## Why this fetches instead of taking a playback id
 *
 * The tag in the CMS body carries a resource id, which is not a secret and can
 * sit in the statically rendered page. The playback id never does: it arrives
 * from `/api/restricted-videos/:id`, which reads the viewer's session and
 * decides. That is what lets the workshop page stay `force-static` while the
 * video stays private — the gate is a request, not a render.
 *
 * ## Why the failure state is nothing at all
 *
 * Everyone else on the planet loads this page. For them the block is not
 * "locked" or "unavailable", it simply is not part of the page, and an empty
 * reserved box or a spinner that resolves to nothing would say otherwise. So
 * there is no skeleton and no placeholder: null until the bytes are in hand,
 * null forever if they never are.
 */
export function TeamWelcomeVideo({
	resourceId,
	title,
	className,
}: {
	resourceId: string
	/** Overrides the title stored on the video resource. */
	title?: string
	className?: string
}) {
	const [video, setVideo] = React.useState<RestrictedVideoPayload | null>(null)

	React.useEffect(() => {
		if (!resourceId) {
			return
		}

		const controller = new AbortController()

		const load = async () => {
			try {
				const response = await fetch(
					`/api/restricted-videos/${encodeURIComponent(resourceId)}`,
					{ signal: controller.signal, credentials: 'same-origin' },
				)

				if (!response.ok) {
					return
				}

				const payload =
					(await response.json()) as Partial<RestrictedVideoPayload>

				if (!payload?.playbackId) {
					return
				}

				setVideo({
					playbackId: payload.playbackId,
					title: payload.title ?? null,
					duration: payload.duration ?? null,
				})
			} catch {
				// 403, offline, aborted navigation — all the same outcome: the block
				// is not part of this reader's page.
			}
		}

		void load()

		return () => controller.abort()
	}, [resourceId])

	const resolvedTitle = title ?? video?.title ?? 'Welcome'
	const metadata = useMuxMetadata({
		videoId: resourceId,
		videoTitle: resolvedTitle,
		contentType: 'team-welcome',
	})

	if (!video) {
		return null
	}

	return (
		// `aspect-video` on the WRAPPER, not the player: until the custom element
		// upgrades the browser lays `<mux-player>` out as an unknown inline
		// element, so an aspect ratio on it does nothing and everything below
		// jumps when it finally resolves.
		<div
			className={cn(
				'not-prose bg-muted relative my-8 aspect-video w-full overflow-hidden rounded-md',
				className,
			)}
		>
			<MuxPlayer
				metadata={metadata}
				streamType="on-demand"
				playbackRates={[0.75, 1, 1.25, 1.5, 1.75, 2]}
				maxResolution="2160p"
				minResolution="540p"
				accentColor="#DD9637"
				playbackId={video.playbackId}
				title={resolvedTitle}
				playsInline
				className="absolute inset-0 h-full w-full"
			/>
		</div>
	)
}
