'use client'

import * as React from 'react'
import { Suspense } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { LessonPlayer } from '@/app/(content)/_components/lesson-player'
import { NewLessonVideoForm } from '@/app/(content)/_components/new-lesson-video-form'
import { SimplePostPlayer } from '@/app/(content)/posts/_components/post-player'
import { reprocessTranscript } from '@/app/(content)/posts/[slug]/edit/actions'
import Spinner from '@/components/spinner'
import { VideoChaptersEditor } from '@/components/video-chapters/video-chapters-editor'
import { env } from '@/env.mjs'
import { useTranscript } from '@/hooks/use-transcript'
import { api } from '@/trpc/react'
import { pollVideoResource } from '@/utils/poll-video-resource'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import { Shuffle, TrashIcon, Unlink } from 'lucide-react'
import type { UseFormReturn } from 'react-hook-form'

import { VideoResource } from '@coursebuilder/core/schemas'
import { cn } from '@coursebuilder/ui/utils/cn'
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
	FormDescription,
	FormLabel,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@coursebuilder/ui'
import { useSocket } from '@coursebuilder/ui/hooks/use-socket'

/**
 * Base interface that any content resource must implement
 */
interface ContentResourceBase {
	id: string
	fields: {
		[key: string]: any
		title?: string
		thumbnailTime?: number | null
	}
}

/**
 * Props interface for the ContentVideoResourceField component
 */
interface ContentVideoResourceFieldProps<T extends ContentResourceBase> {
	/**
	 * The content resource (post, lesson, solution, etc.)
	 */
	resource: T

	/**
	 * The form instance from react-hook-form
	 */
	form: UseFormReturn<any>

	/**
	 * Video resource object to display
	 */
	videoResource?: VideoResource | null

	/**
	 * Label to display for the video field
	 */
	label?: string

	/**
	 * Callback when video is updated
	 * Receives resource ID, video resource ID, and optional additional fields
	 */
	onVideoUpdate?: (
		resourceId: string,
		videoResourceId: string,
		additionalFields?: Record<string, any>,
	) => Promise<void>

	/**
	 * Whether thumbnail selection is enabled
	 */
	thumbnailEnabled?: boolean

	/**
	 * Whether to show transcript
	 */
	showTranscript?: boolean

	/**
	 * Whether to show the chapters editor
	 */
	showChapters?: boolean

	/**
	 * Optional className to apply to the container
	 */
	className?: string

	/**
	 * Whether video is required
	 */
	required?: boolean

	/**
	 * 'default' keeps the legacy edit-form styling (negative margins, border-b
	 * bleeds, single-row actions). 'panel' renders for the cms editor's left
	 * panel: no bleeds, rounded player frame, actions wrapping in a 2-col grid
	 * (prototype contract).
	 */
	variant?: 'default' | 'panel'
}

/**
 * A generic video resource field component that works with any content resource
 * Handles video upload, replacement, and optionally thumbnail selection
 */
export const ContentVideoResourceField = <T extends ContentResourceBase>({
	resource,
	form,
	videoResource: initialVideoResource,
	label = 'Video',
	thumbnailEnabled = false,
	showTranscript = true,
	showChapters = true,
	className = '',
	required = false,
	onVideoUpdate,
	variant = 'default',
}: ContentVideoResourceFieldProps<T>) => {
	const panel = variant === 'panel'
	const router = useRouter()
	const [videoResourceId, setVideoResourceId] = React.useState(
		initialVideoResource?.id,
	)

	React.useEffect(() => {
		setVideoResourceId(initialVideoResource?.id)
	}, [initialVideoResource?.id])

	const { data: videoResource, refetch } = api.videoResources.get.useQuery(
		{
			videoResourceId: videoResourceId,
		},
		{
			enabled: Boolean(videoResourceId),
		},
	)

	const [videoUploadStatus, setVideoUploadStatus] = React.useState<
		'loading' | 'finalizing upload'
	>('loading')

	const [replacingVideo, setReplacingVideo] = React.useState(false)
	const [showDetachConfirmation, setShowDetachConfirmation] =
		React.useState(false)

	const {
		transcript,
		setTranscript,
		setIsProcessing: setIsTranscriptProcessing,
		isProcessing: isTranscriptProcessing,
		TranscriptDialog,
	} = useTranscript({
		videoResourceId: videoResource?.id,
		initialTranscript: videoResource?.transcript,
	})

	// Reference for player when thumbnail functionality is enabled
	const playerRef = React.useRef<MuxPlayerRefAttributes>(null)
	const [thumbnailTime, setThumbnailTime] = React.useState(
		form.watch('fields.thumbnailTime') || 0,
	)

	// Socket connection for video and transcript updates
	useSocket({
		room: videoResource?.id,
		host: env.NEXT_PUBLIC_PARTY_KIT_URL,
		onMessage: async (messageEvent) => {
			try {
				const data = JSON.parse(messageEvent.data)

				switch (data.name) {
					case 'video.asset.ready':
					case 'videoResource.created':
						if (data.body.id) {
							refetch()
						}
						break
					case 'transcript.ready':
						setTranscript(data.body)
						setIsTranscriptProcessing(false)
						refetch()
						break
					case 'video.asset.attached':
						console.log('video.asset.attached', data.body)
						setVideoResourceId(data.body.videoResourceId)
						refetch()
						break
					case 'video.asset.detached':
						setVideoResourceId(undefined)
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

	// Effect to poll video resource until it's ready
	React.useEffect(() => {
		async function pollVideo() {
			if (videoResource?.id) {
				await pollVideoResource(videoResource.id).next()
				refetch()
			}
		}

		if (!['ready', 'errored'].includes(videoResource?.state || '')) {
			pollVideo()
		}
	}, [videoResource?.state, videoResource?.id, refetch])

	const { mutateAsync: detachFromPost } =
		api.videoResources.detachFromPost.useMutation()

	const handleDetachVideo = async () => {
		if (videoResource?.id) {
			try {
				await detachFromPost({
					postId: resource.id,
					videoResourceId: videoResource.id,
				})

				setVideoResourceId(undefined)
				form.setValue('fields.videoResourceId', undefined)
			} catch (error) {
				console.error('Failed to detach video:', error)
			} finally {
				setShowDetachConfirmation(false)
			}
		}
	}

	return (
		<TooltipProvider>
			<div className={className}>
				{videoResource?.id || videoResourceId ? (
					replacingVideo ? (
						<div className={cn(!panel && '-mt-7')}>
							<NewLessonVideoForm
								parentResourceId={resource.id}
								onVideoUploadCompleted={(videoResourceId) => {
									setReplacingVideo(false)
									setVideoUploadStatus('finalizing upload')
									refetch()
								}}
								onVideoResourceCreated={(videoResourceId) => {
									setVideoResourceId(videoResourceId)
									form.setValue('fields.videoResourceId', videoResourceId)
									refetch()
								}}
							/>
							<div
								className={cn(
									'flex items-center gap-1 py-2',
									!panel && 'border-b px-4',
								)}
							>
								<Button
									variant="secondary"
									size={'sm'}
									type="button"
									onClick={() => setReplacingVideo(false)}
								>
									Cancel Replace Video
								</Button>
							</div>
						</div>
					) : (
						<>
							{videoResource && videoResource.state === 'ready' ? (
								<div className={cn(!panel && '-mt-5 border-b')}>
									<div
										className={cn(
											'flex items-center justify-center',
											panel &&
												'border-border overflow-hidden rounded-md border',
										)}
									>
										{thumbnailEnabled ? (
											<SimplePostPlayer
												className="aspect-video h-auto w-full"
												ref={playerRef}
												thumbnailTime={form.watch('fields.thumbnailTime') || 0}
												handleVideoTimeUpdate={(e: Event) => {
													const currentTime = (e.target as HTMLMediaElement)
														.currentTime
													if (currentTime) {
														setThumbnailTime(currentTime)
													}
												}}
												videoResource={videoResource}
											/>
										) : (
											<LessonPlayer
												title={resource.fields?.title}
												videoResource={videoResource}
											/>
										)}
									</div>
									<div
										className={cn(
											panel
												? // Prototype contract: actions wrap in a 2-col grid of
													// slim, quiet buttons (11px, h-7, muted until hover).
													'grid grid-cols-2 gap-1.5 py-2 [&>button]:w-full [&_button]:h-7 [&_button]:border-border [&_button]:text-[11px] [&_button]:font-normal [&_button]:text-muted-foreground [&_button:hover]:text-foreground'
												: 'flex items-center gap-1 overflow-x-auto px-4 py-2 md:overflow-x-visible',
										)}
									>
										<Button
											variant="outline"
											size={'sm'}
											type="button"
											onClick={() => setReplacingVideo(true)}
										>
											Replace Video
										</Button>
										{/* In panel mode the transcript lives in its own visible
										    block below the grid (excerpt + inline reprocess). */}
										{!panel && showTranscript && transcript && TranscriptDialog}
										{!panel && !transcript && isTranscriptProcessing && (
											<Button
												variant="outline"
												size={'sm'}
												type="button"
												disabled
											>
												<Spinner className="mr-2 h-3 w-3" />
												Processing Transcript...
											</Button>
										)}
										{!panel && !transcript && !isTranscriptProcessing && (
											<Button
												variant="outline"
												size={'sm'}
												type="button"
												onClick={() => {
													setIsTranscriptProcessing(true)
													reprocessTranscript({
														videoResourceId: videoResource.id,
													})
												}}
											>
												Add Transcript
											</Button>
										)}
										{thumbnailEnabled && (
											<Tooltip delayDuration={0}>
												<div className={cn('flex items-center', panel && 'w-full')}>
													<TooltipTrigger asChild>
														<Button
															type="button"
															className={cn(
																'rounded-r-none border-r-0',
																panel && 'flex-1',
															)}
															disabled={thumbnailTime === 0}
															onClick={async () => {
																form.setValue(
																	'fields.thumbnailTime',
																	thumbnailTime,
																)

																if (onVideoUpdate) {
																	await onVideoUpdate(
																		resource.id,
																		videoResource.id,
																		{ thumbnailTime },
																	)
																}
															}}
															variant="outline"
															size={'sm'}
														>
															<span>Set Thumbnail</span>
														</Button>
													</TooltipTrigger>
													<Button
														type="button"
														className="border-secondary rounded-l-none border bg-transparent px-2"
														variant="secondary"
														size={'sm'}
														onClick={() => {
															if (playerRef.current?.seekable) {
																const seekableEnd =
																	playerRef.current.seekable.end(0)
																// Generate a random time between 0 and the end of the video
																const randomTime = Math.floor(
																	Math.random() * seekableEnd,
																)
																playerRef.current.currentTime = randomTime
																playerRef.current.thumbnailTime = randomTime
															}
														}}
													>
														<Shuffle className="h-3 w-3" />
													</Button>
												</div>
												<TooltipContent side="bottom">
													<div className="text-xs">
														current thumbnail:
														<Image
															src={`https://image.mux.com/${videoResource.muxPlaybackId}/thumbnail.webp?time=${form.watch('fields.thumbnailTime')}`}
															className="aspect-video"
															width={192}
															height={108}
															alt="Thumbnail"
														/>
													</div>
												</TooltipContent>
											</Tooltip>
										)}
										{showChapters && videoResource?.id && (
											<div className={cn(panel && 'w-full [&>button]:w-full')}>
												<VideoChaptersEditor
													videoResourceId={videoResource.id}
													initialChapters={videoResource.chapters}
													videoDuration={videoResource.duration}
												/>
											</div>
										)}
										{panel ? (
											<Button
												variant="outline"
												size="sm"
												className="w-full"
												type="button"
												onClick={() => setShowDetachConfirmation(true)}
											>
												<Unlink className="mr-1.5 h-3 w-3" />
												Detach Video
											</Button>
										) : (
											<Tooltip delayDuration={0}>
												<TooltipTrigger asChild>
													<Button
														variant="outline"
														size="icon"
														className="h-6 w-6 shrink-0"
														type="button"
														onClick={() => setShowDetachConfirmation(true)}
													>
														<Unlink className="h-3 w-3" />
													</Button>
												</TooltipTrigger>
												<TooltipContent side="bottom" className="px-1 py-0">
													<span className="text-xs">Detach video</span>
												</TooltipContent>
											</Tooltip>
										)}
									</div>
								{/* Panel transcript block — always visible so it's obvious a
								    transcript exists (or doesn't); excerpt + inline reprocess
								    replace the grid button + buried-modal-only access. */}
								{panel && showTranscript ? (
									<div className="border-border bg-muted/40 mb-2 space-y-1.5 rounded-md border p-2.5">
										<div className="flex items-baseline gap-3">
											<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
												Transcript
											</span>
											<div className="flex-1" />
											<button
												type="button"
												disabled={isTranscriptProcessing}
												onClick={() => {
													setIsTranscriptProcessing(true)
													reprocessTranscript({
														videoResourceId: videoResource.id,
													})
												}}
												className="text-primary text-[11px] hover:underline disabled:opacity-50 disabled:hover:no-underline"
											>
												{isTranscriptProcessing ? 'Reprocessing…' : '↻ Reprocess'}
											</button>
											{transcript ? (
												<span className="[&_button]:text-primary [&_button]:h-auto [&_button]:border-0 [&_button]:bg-transparent [&_button]:p-0 [&_button]:text-[11px] [&_button]:font-normal [&_button:hover]:underline">
													{TranscriptDialog}
												</span>
											) : null}
										</div>
										{transcript ? (
											<p className="text-muted-foreground line-clamp-3 font-mono text-[11px] leading-relaxed">
												{transcript}
											</p>
										) : (
											<p className="text-muted-foreground text-[11px]">
												{isTranscriptProcessing
													? 'Processing transcript…'
													: 'No transcript yet — Reprocess generates one from the video.'}
											</p>
										)}
									</div>
								) : null}
								</div>
							) : videoResource ? (
								<div
									className={cn(
										'bg-muted/75 flex aspect-video h-full w-full flex-col items-center justify-center gap-3 p-5 text-sm',
										panel
											? 'border-border rounded-md border'
											: '-mt-5 mb-[42px]',
									)}
								>
									{videoResource.state === 'errored' ? (
										<>
											<span className="text-destructive">video is errored</span>
											<div className="flex gap-2">
												<Button
													variant="outline"
													size="sm"
													type="button"
													onClick={() => setReplacingVideo(true)}
												>
													Replace Video
												</Button>
												<Button
													variant="outline"
													size="sm"
													type="button"
													onClick={() => setShowDetachConfirmation(true)}
												>
													<Unlink className="mr-1.5 h-3 w-3" />
													Detach Video
												</Button>
											</div>
										</>
									) : (
										<>
											<Spinner className="h-5 w-5" />
											<span>video is {videoResource.state}</span>
										</>
									)}
								</div>
							) : (
								<div
									className={cn(
										'bg-muted/75 flex aspect-video h-full w-full flex-col items-center justify-center gap-3 p-5 text-sm',
										panel
											? 'border-border rounded-md border'
											: '-mt-5 mb-[42px]',
									)}
								>
									<Spinner className="h-5 w-5" />
									<span>video is {videoUploadStatus}</span>
								</div>
							)}
							{/* Detach Confirmation Dialog */}
							<AlertDialog
								open={showDetachConfirmation}
								onOpenChange={setShowDetachConfirmation}
							>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Detach Video</AlertDialogTitle>
										<AlertDialogDescription>
											Are you sure you want to detach this video from the
											content? This action will remove the video from this
											content but won't delete the video resource.
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
				) : (
					<div className={cn(!panel && '-mt-7')}>
						<NewLessonVideoForm
							parentResourceId={resource.id}
							onVideoUploadCompleted={(videoResourceId) => {
								setVideoUploadStatus('finalizing upload')
								refetch()
							}}
							onVideoResourceCreated={(videoResourceId) => {
								setVideoResourceId(videoResourceId)
								form.setValue('fields.videoResourceId', videoResourceId)
								refetch()
							}}
						/>
						{/* The panel's tab already says "Video" — the label row is legacy chrome. */}
						{!videoResource?.id && !panel && (
							<div className="flex items-baseline gap-3 border-b px-5 py-2">
								<FormLabel className="text-base font-bold">{label}</FormLabel>
								{!required && (
									<FormDescription className="pb-0">
										Add a video for this content (optional).
									</FormDescription>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</TooltipProvider>
	)
}
