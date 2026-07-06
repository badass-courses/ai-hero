'use client'

import * as React from 'react'
import { LessonPlayer } from '@/app/(content)/_components/lesson-player'
import { NewLessonVideoForm } from '@/app/(content)/_components/new-lesson-video-form'
import { SimplePostPlayer } from '@/app/(content)/posts/_components/post-player'
import { reprocessTranscript } from '@/app/(content)/posts/[slug]/edit/actions'
import { VideoChaptersEditor } from '@/components/video-chapters/video-chapters-editor'
import { useSocket } from '@/hooks/use-socket'
import { useTranscript } from '@/hooks/use-transcript'
import {
	VIDEO_ATTACHED_EVENT,
	VIDEO_DETACHED_EVENT,
} from '@/inngest/events/video-attachment'
import {
	createVideoAnalyticsBinding,
	createVideoLibraryBinding,
	listVideoPickerItems,
} from '@/lib/cms/post-bindings'
import { fetchVideoAnalyticsSummary } from '@/lib/cms/video-analytics-actions'
import {
	attachVideoResourceToPost,
	detachVideoResourceFromPost,
	getVideoResourceMediaDetail,
} from '@/lib/video-resource-query'
import { api } from '@/trpc/react'
import { pollVideoResource } from '@/utils/poll-video-resource'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import type { UseFormReturn } from 'react-hook-form'

import type { VideoResource } from '@coursebuilder/core/schemas'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	useToast,
} from '@coursebuilder/ui'
import {
	ResourcePicker,
	VideoField,
	VideoPreviewDialog,
	type VideoFieldStatus,
} from '@coursebuilder/ui/cms'
import type {
	PickerItem,
	VideoAnalyticsSummary,
	VideoDetail,
} from '@coursebuilder/ui/cms/manifest'

/** The minimum an owning resource must expose (post/lesson/solution/…). */
interface OwningResource {
	id: string
	fields: {
		[key: string]: any
		title?: string
		thumbnailTime?: number | null
	}
}

export interface CmsVideoFieldProps {
	/** The OWNING resource — join target, socket room, thumbnailTime home. */
	resource: OwningResource
	/** The editor's form (kit `EditorCtx.form`, cast at the call site). */
	form: UseFormReturn<any>
	/** Server-fetched primary video (null → upload state). */
	videoResource?: VideoResource | null
	/**
	 * Persist `fields.thumbnailTime` on the OWNING resource immediately
	 * (per-type save: updatePost/updateLesson/updateSolution/…). The wrapper
	 * already wrote the value into the form before calling this.
	 */
	onThumbnailUpdate?: (opts: {
		thumbnailTime: number
		videoResourceId: string
	}) => Promise<void>
	/**
	 * Mux Data configured? Server-computed by the edit page — gates the
	 * analytics strip under the player (and in the details dialog).
	 */
	videoAnalyticsEnabled?: boolean
	/**
	 * false → the read-only `LessonPlayer` replaces the seekable
	 * `SimplePostPlayer` and the thumbnail row is hidden. All current cms
	 * types keep the default (true).
	 */
	thumbnailEnabled?: boolean
	className?: string
}

/**
 * The ONE Video-tab implementation for every cms editor type — fills the kit
 * `VideoField`'s real slots (player/status/title/actions/transcript/
 * thumbnail/analytics/muxHref/details) instead of the children escape hatch
 * the per-type `VideoResourceField`/`LessonVideoResourceField` wrappers used.
 *
 * Division of responsibility (doc 17 §2): this tab is THIS resource's
 * primary video only. The library lives in the Media tab; "Choose existing"
 * here is a compact attach dialog (row-click previews, attach is an explicit
 * row action — the safe-swap contract), with a "Browse all in Media →" hint.
 *
 * App-entangled machinery stays here, out of the kit: tRPC videoResource
 * fetch, PartyKit sockets (asset/transcript lifecycle + attach/detach
 * broadcasts), processing poll, uploadthing upload (`NewLessonVideoForm`),
 * transcript dialog (`useTranscript`), and the generalized attach/detach
 * server actions.
 */
export function CmsVideoField({
	resource,
	form,
	videoResource: initialVideoResource,
	onThumbnailUpdate,
	videoAnalyticsEnabled,
	thumbnailEnabled = true,
	className,
}: CmsVideoFieldProps) {
	const { toast } = useToast()

	const [videoResourceId, setVideoResourceId] = React.useState(
		initialVideoResource?.id,
	)
	React.useEffect(() => {
		setVideoResourceId(initialVideoResource?.id)
	}, [initialVideoResource?.id])

	const { data: fetchedVideoResource, refetch } =
		api.videoResources.get.useQuery(
			{ videoResourceId },
			{ enabled: Boolean(videoResourceId) },
		)
	// Until the client fetch lands, render from the server-provided resource
	// so the player never flashes back to "processing" on mount.
	const videoResource =
		fetchedVideoResource && fetchedVideoResource.id === videoResourceId
			? fetchedVideoResource
			: videoResourceId === initialVideoResource?.id
				? initialVideoResource
				: null

	const [replacingVideo, setReplacingVideo] = React.useState(false)
	const [showDetachConfirmation, setShowDetachConfirmation] =
		React.useState(false)
	const [chooseOpen, setChooseOpen] = React.useState(false)
	const [previewItem, setPreviewItem] = React.useState<PickerItem | null>(null)
	const [isAttaching, setIsAttaching] = React.useState(false)

	const {
		transcript,
		setTranscript,
		setIsProcessing: setIsTranscriptProcessing,
		isProcessing: isTranscriptProcessing,
		TranscriptDialog,
		openTranscriptDialog,
	} = useTranscript({
		videoResourceId: videoResource?.id,
		initialTranscript: videoResource?.transcript,
		withDialogTrigger: false,
	})

	// Thumbnail-from-player-time: the ref tracks the seek position.
	const playerRef = React.useRef<MuxPlayerRefAttributes>(null)
	const [thumbnailTime, setThumbnailTime] = React.useState<number>(
		form.watch('fields.thumbnailTime') || 0,
	)

	// Lifecycle socket — this VIDEO's room (asset ready, transcript ready).
	useSocket({
		room: videoResource?.id,
		onMessage: async (messageEvent) => {
			try {
				const data = JSON.parse(messageEvent.data)
				switch (data.name) {
					case 'video.asset.ready':
					case 'videoResource.created':
						if (data.body.id) refetch()
						break
					case 'transcript.ready':
						setTranscript(data.body)
						setIsTranscriptProcessing(false)
						refetch()
						break
					default:
						break
				}
			} catch (error) {
				// nothing to do
			}
		},
	})

	// Attachment socket — the OWNING resource's room (attach/detach
	// broadcasts from the Inngest pipeline, e.g. Media tab "Set as primary").
	useSocket({
		room: resource.id || undefined,
		onMessage: async (messageEvent) => {
			try {
				const message = JSON.parse(messageEvent.data)
				if (message.name === VIDEO_ATTACHED_EVENT) {
					const attachedId = message.body?.videoResourceId
					if (attachedId) {
						toast({ title: 'New video asset attached' })
						setVideoResourceId(attachedId)
						form.setValue('fields.videoResourceId', attachedId)
						refetch()
					}
				}
				if (message.name === VIDEO_DETACHED_EVENT) {
					// Guard against a safe-swap race: detach(A) and attach(B) are
					// separate async broadcasts, so a late detach for the PREVIOUS
					// video must not wipe the just-attached one.
					const detachedId = message.body?.videoResourceId
					if (!detachedId || detachedId === videoResourceId) {
						toast({ title: 'Video asset detached' })
						setVideoResourceId(undefined)
						form.setValue('fields.videoResourceId', undefined)
					}
				}
			} catch (error) {
				// nothing to do
			}
		},
	})

	// Poll the video resource until it settles (socket-miss safety net).
	React.useEffect(() => {
		async function pollVideo() {
			if (videoResource?.id) {
				await pollVideoResource(videoResource.id).next()
				refetch()
			}
		}
		if (
			videoResource?.id &&
			!['ready', 'errored'].includes(videoResource?.state || '')
		) {
			pollVideo()
		}
	}, [videoResource?.state, videoResource?.id, refetch])

	// Detail (title / muxHref / metadata source) — lazy server fetch, keyed by
	// video + state so "Open in Mux" appears once the Mux asset exists.
	const [detail, setDetail] = React.useState<VideoDetail | null>(null)
	React.useEffect(() => {
		const id = videoResource?.id
		setDetail(null)
		if (!id) {
			return
		}
		let alive = true
		getVideoResourceMediaDetail(id)
			.then((result) => {
				if (alive) setDetail(result)
			})
			.catch(() => {
				// detail is decoration — never worth breaking the tab over
			})
		return () => {
			alive = false
		}
	}, [videoResource?.id, videoResource?.state])

	// Analytics strip — lazy, only when the server page saw Mux Data env.
	const [analytics, setAnalytics] = React.useState<
		VideoAnalyticsSummary | null | 'loading' | undefined
	>(undefined)
	React.useEffect(() => {
		const id = videoResource?.id
		if (!videoAnalyticsEnabled || !id || videoResource?.state !== 'ready') {
			setAnalytics(undefined)
			return
		}
		let alive = true
		setAnalytics('loading')
		fetchVideoAnalyticsSummary(id)
			.then((result) => {
				if (alive) setAnalytics(result)
			})
			.catch(() => {
				if (alive) setAnalytics(null)
			})
		return () => {
			alive = false
		}
	}, [videoAnalyticsEnabled, videoResource?.id, videoResource?.state])

	// Shared bindings for the details/preview dialogs (same objects the Media
	// tab uses) — set-as-primary targets THIS resource when it exists.
	const videoLibrary = React.useMemo(
		() =>
			createVideoLibraryBinding(
				resource.id ? { primaryResourceId: resource.id } : undefined,
			),
		[resource.id],
	)
	const videoAnalytics = React.useMemo(
		() => createVideoAnalyticsBinding(videoAnalyticsEnabled),
		[videoAnalyticsEnabled],
	)

	const handleDetachVideo = async () => {
		if (!videoResource?.id) return
		try {
			await detachVideoResourceFromPost(resource.id, videoResource.id)
			setVideoResourceId(undefined)
			form.setValue('fields.videoResourceId', undefined)
		} catch (error) {
			console.error('Failed to detach video:', error)
			toast({ title: 'Could not detach video', variant: 'destructive' })
		} finally {
			setShowDetachConfirmation(false)
		}
	}

	// Safe-swap attach (the proven contract from the legacy post picker):
	// replaces any existing videoResource join row + broadcasts events.
	const handleAttach = async (item: PickerItem) => {
		if (isAttaching || item.id === videoResource?.id) return
		setIsAttaching(true)
		try {
			const attached = await attachVideoResourceToPost(resource.id, item.id)
			if (attached === false) throw new Error('Attach failed')
			setVideoResourceId(item.id)
			form.setValue('fields.videoResourceId', item.id)
			setChooseOpen(false)
			setPreviewItem(null)
			toast({ title: 'Video attached' })
		} catch (error) {
			console.error('Failed to attach video:', error)
			toast({ title: 'Could not attach video', variant: 'destructive' })
		} finally {
			setIsAttaching(false)
		}
	}

	const handleThumbnailPick = async () => {
		if (!videoResource?.id) return
		if (!thumbnailTime) {
			toast({
				title: 'Play or seek the video first',
				description: 'The current player time becomes the thumbnail.',
			})
			return
		}
		form.setValue('fields.thumbnailTime', thumbnailTime)
		try {
			await onThumbnailUpdate?.({
				thumbnailTime,
				videoResourceId: videoResource.id,
			})
			toast({ title: 'Thumbnail updated' })
		} catch (error) {
			console.error('Failed to persist thumbnail time:', error)
			toast({ title: 'Could not save thumbnail', variant: 'destructive' })
		}
	}

	// ---- kit slot values -----------------------------------------------------

	const hasVideo = Boolean(videoResourceId)
	const uploading = !replacingVideo && hasVideo && !videoResource

	const status: VideoFieldStatus =
		!hasVideo || replacingVideo
			? 'none'
			: uploading
				? 'processing'
				: videoResource?.state === 'ready'
					? 'ready'
					: videoResource?.state === 'errored'
						? 'error'
						: 'processing'

	const uploader = (
		<div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 [&_label]:w-full">
			<NewLessonVideoForm
				parentResourceId={resource.id}
				// Set the id here too (fires right after upload, BEFORE the
				// processing poll): if the poll later fails, onVideoResourceCreated
				// never runs, so this is the only place the attach survives.
				onVideoUploadCompleted={(nextVideoResourceId) => {
					setReplacingVideo(false)
					setVideoResourceId(nextVideoResourceId)
					form.setValue('fields.videoResourceId', nextVideoResourceId)
					refetch()
				}}
				onVideoResourceCreated={(nextVideoResourceId) => {
					setReplacingVideo(false)
					setVideoResourceId(nextVideoResourceId)
					form.setValue('fields.videoResourceId', nextVideoResourceId)
					refetch()
				}}
			/>
			{replacingVideo ? (
				<Button
					variant="secondary"
					size="sm"
					type="button"
					onClick={() => setReplacingVideo(false)}
				>
					Cancel Replace Video
				</Button>
			) : null}
		</div>
	)

	const player =
		!resource.id ? (
			// CREATE mode (e.g. a not-yet-saved solution): uploading now would
			// attach the video to an empty parent id and lose it on the first
			// save + refresh. Gate the uploader behind the first save.
			<div className="text-muted-foreground flex h-full w-full items-center justify-center p-4 text-center text-[13px]">
				Save this resource first, then add a video.
			</div>
		) : !hasVideo || replacingVideo ? (
			uploader
		) : videoResource?.state === 'ready' ? (
			thumbnailEnabled ? (
				<SimplePostPlayer
					className="aspect-video h-full w-full"
					ref={playerRef}
					thumbnailTime={form.watch('fields.thumbnailTime') || 0}
					handleVideoTimeUpdate={(e: Event) => {
						const currentTime = (e.target as HTMLMediaElement).currentTime
						if (currentTime) setThumbnailTime(currentTime)
					}}
					videoResource={videoResource}
				/>
			) : (
				<LessonPlayer
					title={resource.fields?.title}
					videoResource={videoResource}
				/>
			)
		) : undefined

	const thumbTime = form.watch('fields.thumbnailTime') || 0
	const thumbnailUrl = videoResource?.muxPlaybackId
		? `https://image.mux.com/${videoResource.muxPlaybackId}/thumbnail.webp?time=${thumbTime}`
		: undefined

	const ready = videoResource?.state === 'ready'

	return (
		<>
			<VideoField
				className={className}
				player={player}
				status={status}
				title={
					videoResource
						? (detail?.title ?? videoResource.id)
						: undefined
				}
				muxHref={detail?.muxHref ?? undefined}
				analytics={analytics}
				onReplace={
					videoResource && !replacingVideo
						? () => setReplacingVideo(true)
						: undefined
				}
				onChooseExisting={resource.id ? () => setChooseOpen(true) : undefined}
				onDetach={
					videoResource ? () => setShowDetachConfirmation(true) : undefined
				}
				details={
					videoResource
						? {
								videoResourceId: videoResource.id,
								videoLibrary,
								videoAnalytics,
								thumbnailUrl,
								onRenamed: (id, title) =>
									setDetail((prev) =>
										prev && prev.id === id ? { ...prev, title } : prev,
									),
							}
						: undefined
				}
				transcript={
					videoResource
						? {
								text: transcript ?? undefined,
								status: isTranscriptProcessing
									? 'processing'
									: transcript
										? 'ready'
										: undefined,
								onEdit: transcript ? openTranscriptDialog : undefined,
								onRequest: async () => {
									setIsTranscriptProcessing(true)
									try {
										await reprocessTranscript({
											videoResourceId: videoResource.id,
										})
									} catch (error) {
										setIsTranscriptProcessing(false)
										throw error
									}
								},
							}
						: undefined
				}
				thumbnail={
					thumbnailEnabled && ready
						? { url: thumbnailUrl, onPick: handleThumbnailPick }
						: undefined
				}
			>
				{/* chapters stay app-side, composed via the kit's children slot */}
				{videoResource?.id && ready ? (
					<VideoChaptersEditor
						videoResourceId={videoResource.id}
						initialChapters={videoResource.chapters}
						videoDuration={videoResource.duration}
					/>
				) : null}
			</VideoField>

			{/* transcript dialog (imperatively opened via the kit's View ✓) */}
			{TranscriptDialog}

			{/* compact attach dialog — the library itself lives in the Media tab */}
			<Dialog open={chooseOpen} onOpenChange={setChooseOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Choose existing video</DialogTitle>
					</DialogHeader>
					<ResourcePicker
						query={listVideoPickerItems}
						excludeIds={videoResource ? [videoResource.id] : undefined}
						onPick={handleAttach}
						onPreview={(item) => setPreviewItem(item)}
						// Row click previews (safe); the swap is an explicit menu action —
						// a misclick must never replace the primary video.
						rowClick="preview"
						rowActions={(item) => [
							{
								label: videoResource
									? 'Use as primary video (swaps current)'
									: 'Use as primary video',
								onSelect: handleAttach,
								destructive: Boolean(videoResource),
							},
							{ label: 'Preview', onSelect: (row) => setPreviewItem(row) },
							{
								label: 'Copy video ID',
								onSelect: (row) => {
									void navigator.clipboard.writeText(row.id)
									toast({ title: 'Video ID copied' })
								},
							},
						]}
						placeholder="Search videos… (recent first)"
						limit={10}
					/>
					<p className="text-muted-foreground text-[11px]">
						{isAttaching
							? 'Attaching…'
							: 'Click a video to preview it — attach via its ⋯ menu. Browse all in the Media tab →'}
					</p>
				</DialogContent>
			</Dialog>

			{/* shared rich preview dialog for library rows */}
			<VideoPreviewDialog
				item={previewItem}
				videoLibrary={videoLibrary}
				videoAnalytics={videoAnalytics}
				onClose={() => setPreviewItem(null)}
			/>

			{/* detach confirmation */}
			<AlertDialog
				open={showDetachConfirmation}
				onOpenChange={setShowDetachConfirmation}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Detach Video</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to detach this video from the content?
							This action will remove the video from this content but won't
							delete the video resource.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={handleDetachVideo}>
							Detach
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
