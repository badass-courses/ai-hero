'use client'

import * as React from 'react'
import { ContentVideoResourceField } from '@/components/content/content-video-resource-field'
import { env } from '@/env.mjs'
import { useSocket } from '@/hooks/use-socket'
import {
	VIDEO_ATTACHED_EVENT,
	VIDEO_DETACHED_EVENT,
} from '@/inngest/events/video-attachment'
import type { Post } from '@/lib/posts'
import { updatePost } from '@/lib/posts-query'
import { listVideoResourcesForPicker } from '@/lib/resources-query'
import { getVideoResource } from '@/lib/video-resource-query'
import { api } from '@/trpc/react'
import type { UseFormReturn } from 'react-hook-form'

import { TrackedMuxPlayer } from '@/components/content/tracked-mux-player'

import {
	VideoResource,
	type ContentResource,
} from '@coursebuilder/core/schemas'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	useToast,
} from '@coursebuilder/ui'
import { ResourcePicker } from '@coursebuilder/ui/cms'
import type { PickerItem } from '@coursebuilder/ui/cms/manifest'

/** Seconds → 'm:ss' / 'h:mm:ss' for the picker's secondary column. */
function formatDuration(seconds: number | null): string | undefined {
	if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
		return undefined
	}
	const total = Math.round(seconds)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const pad = (value: number) => String(value).padStart(2, '0')
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * A specialized video resource field component for posts
 * Wraps the generic ContentVideoResourceField with post-specific functionality
 */
export const VideoResourceField: React.FC<{
	form: UseFormReturn<any>
	post: Post
	videoResource?: VideoResource | null
	initialVideoResourceId?: string | null
	label?: string
	onVideoUpdate?: (
		resourceId: string,
		videoResourceId: string,
		additionalFields: any,
	) => Promise<void>
	/** 'panel' = cms editor left-panel styling (prototype video-tab layout). */
	variant?: 'default' | 'panel'
}> = ({
	form,
	post,
	videoResource,
	initialVideoResourceId,
	label = 'Video',
	onVideoUpdate,
	variant = 'default',
}) => {
	const { toast } = useToast()
	const [currentVideoResource, setCurrentVideoResource] =
		React.useState<VideoResource | null>(videoResource || null)
	const [isAttaching, setIsAttaching] = React.useState(false)

	const { mutateAsync: attachToPost } =
		api.videoResources.attachToPost.useMutation()

	// PickerQuery over the app's video library (recent-first, id search).
	// `types` is ignored — this picker is videoResource-only by construction.
	const queryVideoLibrary = React.useCallback(
		async ({
			search,
			excludeIds,
			limit,
		}: {
			types?: string[]
			search?: string
			excludeIds?: string[]
			limit?: number
		}): Promise<PickerItem[]> => {
			const rows = await listVideoResourcesForPicker({
				search,
				excludeIds,
				limit,
			})
			return rows.map((row) => ({
				id: row.id,
				// Compact badge label — 'videoResource' would crowd the row.
				type: 'video',
				title: row.title,
				state: row.state,
				detail: formatDuration(row.duration),
				thumbnailUrl: row.thumbnailUrl,
				// Uploads are created, not edited — createdAt is the recency signal.
				updatedAt: row.createdAt ?? undefined,
			}))
		},
		[],
	)

	// Library-row preview: fetch the full videoResource (for muxPlaybackId)
	// and play it in a dialog — attach stays a separate, deliberate click.
	const [previewResource, setPreviewResource] =
		React.useState<VideoResource | null>(null)
	const handlePreview = async (item: PickerItem) => {
		try {
			const resource = await getVideoResource(item.id)
			if (resource?.muxPlaybackId) setPreviewResource(resource)
			else toast({ title: 'Video is still processing — no preview yet' })
		} catch (error) {
			console.error('Failed to load video preview:', error)
			toast({ title: 'Could not load preview', variant: 'destructive' })
		}
	}

	const handleChooseExisting = async (item: PickerItem) => {
		if (isAttaching || item.id === currentVideoResource?.id) return
		setIsAttaching(true)
		try {
			// Same join write as the legacy "Use as primary video": replaces any
			// existing videoResource child and broadcasts attach/detach events.
			const attached = await attachToPost({
				postId: post.id,
				videoResourceId: item.id,
			})
			if (attached === false) {
				throw new Error('Attach failed')
			}
			// No router.refresh(): the attach is persisted by the mutation and the
			// client already holds the authoritative result — local state drives
			// ContentVideoResourceField (which re-fetches player/transcript by id).
			const nextVideoResource = await getVideoResource(item.id)
			setCurrentVideoResource(nextVideoResource)
			form.setValue('fields.videoResourceId' as any, item.id)
			toast({ title: 'Video attached' })
		} catch (error) {
			console.error('Failed to attach video:', error)
			toast({ title: 'Could not attach video', variant: 'destructive' })
		} finally {
			setIsAttaching(false)
		}
	}

	useSocket({
		room: post.id,
		onMessage: async (messageEvent) => {
			try {
				const message = JSON.parse(messageEvent.data)

				if (message.name === VIDEO_ATTACHED_EVENT) {
					console.log('new video asset attached')
					toast({
						title: 'New video asset attached',
					})
					const videoResourceId = message.body?.videoResourceId
					if (videoResourceId) {
						const videoResource = await getVideoResource(videoResourceId)

						setCurrentVideoResource(videoResource)
					} else {
						console.error('Missing videoResourceId in message', message)
					}
				}
				if (message.name === VIDEO_DETACHED_EVENT) {
					console.log('video asset detached')
					toast({
						title: 'Video asset detached',
					})
					setCurrentVideoResource(null)
				}
			} catch (error) {}
		},
	})

	// Use videoResource.id if available, otherwise fall back to initialVideoResourceId
	const videoId = videoResource?.id || initialVideoResourceId

	async function handleVideoUpdate(
		resourceId: string,
		videoResourceId: string,
		additionalFields: any,
	) {
		// Update the form state
		form.setValue('fields.videoResourceId' as any, videoResourceId)

		// If we have thumbnail time, save it to the owning resource immediately.
		if (additionalFields?.thumbnailTime) {
			form.setValue(
				'fields.thumbnailTime' as any,
				additionalFields.thumbnailTime,
			)

			if (onVideoUpdate) {
				await onVideoUpdate(resourceId, videoResourceId, additionalFields)
				return
			}

			// Posts keep their own specialized update path.
			await updatePost(
				{
					id: resourceId,
					fields: {
						...form.watch('fields'),
						thumbnailTime: additionalFields.thumbnailTime,
						videoResourceId,
					} as any,
				},
				'save',
			)
		}
	}

	return (
		<div className={variant === 'panel' ? 'space-y-4' : undefined}>
			<ContentVideoResourceField
				videoResource={currentVideoResource}
				resource={post}
				form={form}
				label={label}
				thumbnailEnabled={true}
				showTranscript={true}
				onVideoUpdate={handleVideoUpdate}
				variant={variant}
			/>
			{/* Video library — always visible (prototype: one surface for the
			    primary video AND the library). Picking attaches as the primary
			    video, replacing the current one; posts keep at most one. */}
			<div className={variant === 'panel' ? 'space-y-1.5' : 'px-5 py-2'}>
				<p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
					Video library
				</p>
				<ResourcePicker
					query={queryVideoLibrary}
					excludeIds={
						currentVideoResource ? [currentVideoResource.id] : undefined
					}
					onPick={handleChooseExisting}
					onPreview={handlePreview}
					// Row click previews (safe); the swap is an explicit menu action —
					// a misclick must never replace the primary video.
					rowClick="preview"
					rowActions={(item) => [
						{
							label: currentVideoResource
								? 'Use as primary video (swaps current)'
								: 'Use as primary video',
							onSelect: handleChooseExisting,
							destructive: Boolean(currentVideoResource),
						},
						{ label: 'Preview', onSelect: handlePreview },
						{
							label: 'Copy video ID',
							onSelect: (row) => {
								void navigator.clipboard.writeText(row.id)
								toast({ title: 'Video ID copied' })
							},
						},
					]}
					placeholder="Search videos… (recent first)"
					limit={8}
				/>
				<p className="text-muted-foreground text-[11px]">
					{isAttaching
						? 'Attaching…'
						: 'Click a video to preview it — attach via its ⋯ menu.'}
				</p>
			</div>
			<Dialog
				open={Boolean(previewResource)}
				onOpenChange={(open) => {
					if (!open) setPreviewResource(null)
				}}
			>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle className="truncate font-mono text-sm">
							{previewResource?.id}
						</DialogTitle>
					</DialogHeader>
					{previewResource?.muxPlaybackId ? (
						<TrackedMuxPlayer
							playbackId={previewResource.muxPlaybackId}
							className="aspect-video w-full"
						/>
					) : null}
				</DialogContent>
			</Dialog>
		</div>
	)
}
