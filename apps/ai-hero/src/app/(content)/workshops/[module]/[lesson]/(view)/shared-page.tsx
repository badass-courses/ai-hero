import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { AuthedVideoPlayer } from '@/app/(content)/_components/authed-video-player'
import { LessonControls } from '@/app/(content)/_components/lesson-controls'
import VideoPlayerOverlay from '@/app/(content)/_components/video-player-overlay'
import { Transcript } from '@/app/(content)/_components/video-transcript-renderer'
import PostToC from '@/app/(content)/posts/_components/post-toc'
import UpNext from '@/app/(content)/workshops/_components/up-next'
import { WorkshopPricing } from '@/app/(content)/workshops/_components/workshop-pricing-server'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { PlayerContainerSkeleton } from '@/components/player-skeleton'
import { ActiveHeadingProvider } from '@/hooks/use-active-heading'
import { getAiCodingDictionary } from '@/lib/ai-coding-dictionary'
import type { Lesson } from '@/lib/lessons'
import {
	getLessonVideoPlaybackResource,
	getLessonVideoTranscript,
} from '@/lib/lessons-query'
import { MinimalWorkshop } from '@/lib/workshops'
import { getPlaybackPositionForResource } from '@/lib/progress'
import { log } from '@/server/logger'
import { compileMDX } from '@/utils/compile-mdx'
import {
	getAbilityForResource,
	type AbilityForResource,
} from '@/utils/get-current-ability-rules'

import { Skeleton } from '@coursebuilder/ui'
import { VideoPlayerOverlayProvider } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/utils/cn'

import { LessonBody } from '../../../_components/lesson-body'

export async function LessonPage({
	lesson,
	problem,
	searchParams,
	params,
	lessonType = 'lesson',
	workshop,
}: {
	params: { module: string; lesson: string }
	exerciseLoader?: Promise<Lesson | null> | null | undefined
	lesson: Lesson | null
	problem?: Lesson | null
	searchParams: { [key: string]: string | string[] | undefined }
	lessonType?: 'lesson' | 'exercise' | 'solution'
	workshop: MinimalWorkshop | null
}) {
	if (!lesson) {
		notFound()
	}

	const abilityLoader = getAbilityForResource(params.lesson, params.module)

	const ability = await abilityLoader

	if (!ability.canViewLesson) {
		redirect(`/workshops/${params.module}`)
	}

	// Compile the lesson body only after the viewer is confirmed allowed to open
	// the lesson. Compilation can resolve embedded video playback IDs server-side
	// (see compile-mdx.tsx), so it must never run for an unauthorized viewer.
	//
	// Same treatment as articles: hand-authored dictionary links get the term's
	// definition on hover, and the auto-linker fills the gaps an author left —
	// terms are linked whether or not someone remembered to link them. Existing
	// links are never touched (the plugin skips `link` nodes) and each term is
	// auto-linked at most once per lesson.
	//
	// The dictionary is fetched from GitHub and does fail (504s observed), so it
	// is strictly best-effort: hover cards are a nicety, and paid course material
	// must never fail to render because a third-party read timed out. On failure
	// the links stay plain links.
	const mdxContentPromise = getAiCodingDictionary()
		.then(({ entries }) => entries)
		.catch(async (error) => {
			await log.warn('lesson.dictionary.unavailable', {
				lessonId: lesson.id,
				error: error instanceof Error ? error.message : String(error),
			})
			return null
		})
		.then((entries) =>
			compileMDX(
				lesson?.fields?.body || '',
				{},
				{},
				{
					lessonId: lesson.id,
					...(entries ? { dictionaryAutoLink: { entries, maxLinks: 3 } } : {}),
				},
			),
		)

	return (
		<main className="w-full">
			<ContentReadTracker
				contentId={lesson.id}
				contentType={lessonType === 'solution' ? 'solution' : 'lesson'}
				contentSlug={String(lesson.fields?.slug ?? params.lesson)}
				parentSlug={params.module}
			/>
			<PlayerContainer
				lesson={lesson}
				searchParams={searchParams}
				params={params}
				lessonType={lessonType}
				workshop={workshop}
				ability={ability}
			/>
			<LessonControls
				abilityLoader={abilityLoader}
				lesson={lesson}
				problem={problem}
				moduleSlug={params.module}
			/>
			<div className="max-w-(--breakpoint-xl) container relative px-5 md:px-10 lg:px-14">
				<div className="relative z-10">
					<article className="">
						<LessonTitle lesson={lesson} />
						{lesson?.fields?.body && lesson?.fields?.body?.length > 300 && (
							<PostToC
								markdown={lesson?.fields?.body}
								className="top-0 -mx-5 mb-5 md:-mx-10 lg:-mx-14"
							/>
						)}
						<Suspense
							fallback={
								<div className="flex flex-col gap-3">
									<Skeleton className="dark:bg-foreground/10 bg-foreground/5 h-12 w-full rounded" />
									<Skeleton className="dark:bg-foreground/10 bg-foreground/5 h-5 w-2/3 rounded" />
									<Skeleton className="dark:bg-foreground/10 bg-foreground/5 h-5 w-1/2 rounded" />
								</div>
							}
						>
							<LessonBody
								lesson={lesson}
								abilityLoader={abilityLoader}
								mdxContentPromise={mdxContentPromise}
								workshop={workshop}
							/>
						</Suspense>
						<TranscriptContainer
							lessonId={lesson?.id}
							abilityLoader={abilityLoader}
						/>

						{/* <Accordion type="single" collapsible className="mt-4">
								<AccordionItem value="contents">
									<AccordionTrigger className="flex w-full items-center font-medium">
										Workshop Contents
									</AccordionTrigger>
									<AccordionContent>
										<Suspense
											fallback={
												<div className="flex w-full shrink-0 flex-col gap-2 p-5">
													<Skeleton className="h-24 w-full bg-gray-100" />
													{new Array(10).fill(null).map((_, i) => (
														<Skeleton
															key={i}
															className="h-8 w-full bg-gray-100"
														/>
													))}
												</div>
											}
										>
											<WorkshopResourceList
												currentLessonSlug={params.lesson}
												className="max-w-none"
											/>
										</Suspense>
									</AccordionContent>
								</AccordionItem>
							</Accordion> */}
					</article>
				</div>
			</div>
			<Suspense fallback={null}>
				<UpNext
					className="rounded-none border-x-0 border-b-0 border-t"
					currentResourceId={lesson?.id}
					abilityLoader={abilityLoader}
				/>
			</Suspense>
		</main>
	)
}

async function TranscriptContainer({
	lessonId,
	className,
	abilityLoader,
}: {
	lessonId: string
	className?: string
	abilityLoader: Promise<
		Omit<AbilityForResource, 'canView'> & {
			canViewWorkshop: boolean
			canViewLesson: boolean
			isPendingOpenAccess: boolean
		}
	>
}) {
	const transcriptLoader = getLessonVideoTranscript(lessonId)

	return (
		<div className={cn('pt-4', className)}>
			<Suspense fallback={<div className="p-5"></div>}>
				<Transcript
					transcriptLoader={transcriptLoader}
					abilityLoader={abilityLoader}
				/>
			</Suspense>
		</div>
	)
}

async function PlayerContainer({
	lesson,
	lessonType = 'lesson',
	searchParams,
	params,
	workshop,
	ability,
}: {
	lesson: Lesson | null
	lessonType?: 'lesson' | 'exercise' | 'solution'
	searchParams: { [key: string]: string | string[] | undefined }
	params: { module: string; lesson: string }
	workshop: MinimalWorkshop | null
	ability: Omit<AbilityForResource, 'canView'> & {
		canViewWorkshop: boolean
		canViewLesson: boolean
		isPendingOpenAccess: boolean
	}
}) {
	if (!lesson) {
		notFound()
	}

	const abilityLoader = getAbilityForResource(params.lesson, params.module)

	const videoPlaybackResource = ability.canViewLesson
		? await getLessonVideoPlaybackResource(lesson.id)
		: null
	const muxPlaybackId = videoPlaybackResource?.muxPlaybackId ?? null
	const playbackPositionLoader = getPlaybackPositionForResource(lesson.id)
	const videoResourceReference = lesson?.resources?.find(({ resource }) => {
		return resource.type === 'videoResource'
	})

	void log.debug('lesson.player.video-resource.loaded', {
		lessonId: lesson.id,
		lessonSlug: lesson.fields?.slug,
		lessonType,
		moduleSlug: params.module,
		videoResourceId: videoPlaybackResource?.id,
		videoResourceReferenceId: videoResourceReference?.resourceId,
		hasMuxPlaybackId: Boolean(muxPlaybackId),
		chapterCount: videoPlaybackResource?.chapters?.length ?? 0,
	})

	if (!muxPlaybackId) {
		return null
	}

	return (
		<VideoPlayerOverlayProvider>
			<section
				aria-label="video"
				className="dark relative flex flex-col items-center justify-center border-b bg-black text-white dark:text-white"
			>
				<Suspense
					fallback={
						<PlayerContainerSkeleton className="h-auto w-full bg-black md:max-h-[75svh] md:max-w-[calc(75svh*16/9)]" />
					}
				>
					<WorkshopPricing
						moduleSlug={params.module}
						searchParams={searchParams}
					>
						{(pricingProps) => (
							<VideoPlayerOverlay
								resource={lesson}
								abilityLoader={abilityLoader}
								pricingProps={pricingProps}
								moduleType="workshop"
								moduleSlug={params.module}
								workshop={workshop}
							/>
						)}
					</WorkshopPricing>
					<AuthedVideoPlayer
						key={lesson.id}
						// The width cap mirrors the height cap: with only max-h, a short
						// viewport clamps the height while the width stays full, the box
						// stops being 16:9, and Safari/Chrome each mangle the mismatch
						// (cropped video, cut-off controls). Height-capped + width-capped
						// keeps the box a true 16:9 that always fits the viewport.
						className="aspect-video h-auto w-full max-w-full overflow-hidden md:max-h-[75svh] md:max-w-[calc(75svh*16/9)]"
						muxPlaybackId={muxPlaybackId}
						playbackPositionLoader={playbackPositionLoader}
						// playbackIdLoader={playbackIdLoader}
						resource={lesson}
						videoChapters={videoPlaybackResource?.chapters ?? null}
						abilityLoader={abilityLoader}
						moduleSlug={params.module}
						moduleType="workshop"
						title={lesson.fields?.title}
					/>
				</Suspense>
			</section>
		</VideoPlayerOverlayProvider>
	)
}

async function LessonTitle({ lesson }: { lesson: Lesson | null }) {
	if (!lesson) return null

	return (
		<div>
			{/* <Badge
				className="mb-1 border-none bg-transparent px-0 text-xs uppercase opacity-75"
				variant="outline"
			>
				{lesson.type}
			</Badge> */}
			<h1 className="mb-8 text-3xl font-bold sm:text-3xl lg:text-4xl dark:text-white">
				{lesson.fields?.title}
			</h1>
		</div>
	)
}
