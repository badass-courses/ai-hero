import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { LessonControls } from '@/app/(content)/_components/lesson-controls'
import { LessonVideoSource } from '@/app/(content)/_components/lesson-player-host'
import { Transcript } from '@/app/(content)/_components/video-transcript-renderer'
import PostToC from '@/app/(content)/posts/_components/post-toc'
import UpNext from '@/app/(content)/workshops/_components/up-next'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { env } from '@/env.mjs'
import { ActiveHeadingProvider } from '@/hooks/use-active-heading'
import { getAiCodingDictionary } from '@/lib/ai-coding-dictionary'
import type { Lesson } from '@/lib/lessons'
import {
	getLessonSessionExtract,
	getLessonVideoPlaybackResource,
	getLessonVideoTranscript,
} from '@/lib/lessons-query'
import { MinimalWorkshop } from '@/lib/workshops'
import { getSignedLessonPlayback } from '@/lib/signed-lesson-playback'
import { getPlaybackPositionForResource } from '@/lib/progress'
import { deniedRedirectPath, lessonDenialReason } from '@/lib/lesson-denial'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { compileMDX } from '@/utils/compile-mdx'
import {
	getAbilityForResource,
	type AbilityForResource,
} from '@/utils/get-current-ability-rules'

import { Skeleton } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import { LessonBody } from '../../../_components/lesson-body'

export async function LessonPage({
	lesson,
	problem,
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
	// `getServerAuthSession` is request-cached, and the ability above already
	// read it, so this is not a second lookup.
	const signedIn = Boolean((await getServerAuthSession())?.session?.user?.id)

	if (!ability.canViewLesson) {
		redirect(
			deniedRedirectPath(
				params.module,
				lessonDenialReason({
					signedIn,
					isRegionRestricted: ability.isRegionRestricted,
					isPendingOpenAccess: ability.isPendingOpenAccess,
				}),
			),
		)
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
					...(workshop && ability.canViewWorkshop
						? { officeHoursWorkshopId: workshop.id }
						: {}),
					// Without the dictionary the auto-linker still links the pages
					// it knows (Sandcastle's docs), which need no fetch.
					dictionaryAutoLink: { entries: entries ?? [], maxLinks: 3 },
				},
			),
		)

	// Per page, not in the (learn) layout: the headings belong to this lesson,
	// and the layout outlives a lesson change.
	return (
		<ActiveHeadingProvider>
			<main className="w-full">
				<ContentReadTracker
					contentId={lesson.id}
					contentType={lessonType === 'solution' ? 'solution' : 'lesson'}
					contentSlug={String(lesson.fields?.slug ?? params.lesson)}
					parentSlug={params.module}
				/>
				<LessonVideoRegistration
					workshopId={workshop?.id}
					lesson={lesson}
					params={params}
					lessonType={lessonType}
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
									signedIn={signedIn}
								/>
							</Suspense>
							<TranscriptContainer
								lessonId={lesson?.id}
								abilityLoader={abilityLoader}
							/>
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
		</ActiveHeadingProvider>
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

/**
 * Hands this lesson's video (or `null`) to the player in the (learn) layout.
 * Awaited, never behind Suspense: the host must not keep playing the previous
 * lesson under this one. Only reached after LessonPage's access check, so the
 * playback ID travels exactly as far as it did as a player prop.
 */
async function LessonVideoRegistration({
	lesson,
	lessonType,
	params,
	workshopId,
}: {
	workshopId?: string
	lesson: Lesson
	lessonType: 'lesson' | 'exercise' | 'solution'
	params: { module: string; lesson: string }
}) {
	const [videoPlaybackResource, savedPosition, sessionExtract] =
		await Promise.all([
			getLessonVideoPlaybackResource(lesson.id),
			getPlaybackPositionForResource(lesson.id),
			getLessonSessionExtract(lesson.id),
		])
	const playback = videoPlaybackResource
		? await getSignedLessonPlayback({
				lessonId: lesson.id,
				workshopId,
				moduleSlug: params.module,
				lessonSlug: params.lesson,
				video: videoPlaybackResource,
			})
		: null
	const muxPlaybackId = playback?.muxPlaybackId ?? null
	const videoResourceReference = lesson.resources?.find(({ resource }) => {
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

	return (
		<LessonVideoSource
			video={
				muxPlaybackId
					? {
							resource: lesson,
							muxPlaybackId,
							tokens: playback?.tokens,
							chapters: videoPlaybackResource?.chapters ?? null,
							savedPosition,
							moduleSlug: params.module,
							sessionExtract,
							thumbnailUrl: videoResourceReference
								? `${env.NEXT_PUBLIC_URL}/api/thumbnails?videoResourceId=${videoResourceReference.resourceId}&time=${lesson.fields?.thumbnailTime || 0}`
								: null,
						}
					: null
			}
		/>
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
