'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { setProgressForResource } from '@/lib/progress'
import { type ListNeighbor } from '@/utils/get-nextup-resource-from-list'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { cn } from '@coursebuilder/utils/cn'

import { useProgress } from '../[post]/_components/progress-provider'
import { LoginToSaveProgress } from './post-up-next-card'

/**
 * The lesson pager (`Lesson Page.dc.html` § UP NEXT).
 *
 * Two cells of one hairline grid rather than the full-width "Up Next" card the
 * page used to end with: previous on the page surface, next on the band, with
 * the filled circular arrow pinned to the right of the band cell. The two ends
 * of a lesson's navigation are one decision, and stacking them as two centred
 * bands made the page end twice.
 *
 * Neighbours are resolved on the server (`getListNeighborsFromList`) and passed
 * in, so this only carries the client-side parts: prefetch, progress marking on
 * the way out, and the logged-out progress prompt. With one neighbour the grid
 * collapses to a single cell spanning the row rather than rendering an empty
 * box; with neither, the caller renders nothing.
 */
export function PostUpNextPager({
	postId,
	prev,
	next,
	hideLoginPrompt,
	id,
	className,
}: {
	postId: string
	prev?: ListNeighbor | null
	next?: ListNeighbor | null
	hideLoginPrompt?: boolean
	/** Scroll target, so the ToC rail can list this block. */
	id?: string
	className?: string
}) {
	const router = useRouter()
	const { progress, addLessonProgress, rollbackLessonProgress } = useProgress()
	const { data: session } = useSession()

	React.useEffect(() => {
		if (next) router.prefetch(`/${next.slug}`)
	}, [next, router])

	if (!prev && !next) return null

	const isCompleted = progress?.completedLessons.some(
		(lesson) => lesson.resourceId === postId,
	)

	// `addLessonProgress` marks the lesson done client-side straight away and the
	// link navigates without waiting on the write, so a failed write would
	// otherwise leave a tick the server never recorded.
	//
	// The write can fail two different ways and both have to roll back:
	// `setProgressForResource` is `'use server'`, so its own try/catch runs on
	// the SERVER — a database failure there is logged and returns `null`, which
	// resolves normally and no catch would ever see. A transport failure
	// (offline, a 500 from the action endpoint) rejects out here instead, in the
	// client-side proxy, where nothing awaits this handler.
	//
	// ROLLBACK, not removal: a failed-looking write may still have landed, so
	// the tick is retracted without recording an un-completion that would mask
	// the server's answer for the rest of the session.
	const onContinue = async () => {
		if (isCompleted) return
		addLessonProgress(postId)
		try {
			const saved = await setProgressForResource({
				resourceId: postId,
				isCompleted: true,
			})
			if (!saved) rollbackLessonProgress(postId)
		} catch {
			rollbackLessonProgress(postId)
		}
	}

	return (
		<>
			<nav
				id={id}
				aria-label="Lesson navigation"
				// Anchored blocks sit under a sticky header, so the browser's jump
				// has to stop short of it — same offset the headings use.
				className={cn(
					id && 'scroll-mt-(--nav-height)',
					'border-border bg-border grid grid-cols-1 gap-px',
					prev && next && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
					className,
				)}
			>
				{prev && (
					<Link
						href={`/${prev.slug}`}
						className="bg-background focus-visible:ring-ring group flex flex-col justify-center px-[18px] py-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-11"
					>
						<span
							className={cn(
								TYPE.groupLabel,
								'mb-2.5',
							)}
						>
							Previous
						</span>
						<span
							className={cn(
								TYPE.bodyTight,
								'group-hover:text-foreground text-pretty text-[color:var(--ah-fg-muted)] transition-colors',
							)}
						>
							{/* Lucide, not the `←` character: the glyph rendered at the
							    text's own weight and metrics, so it sat heavier and lower
							    than the matching arrows everywhere else on the page. */}
							<ArrowLeft
								aria-hidden
								className="ease-out-quart mr-1.5 inline-block size-4 shrink-0 align-[-0.15em] transition-transform duration-300 group-hover:-translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
							/>
							{prev.title}
						</span>
					</Link>
				)}
				{next && (
					<Link
						href={`/${next.slug}`}
						onClick={onContinue}
						className="focus-visible:ring-ring group flex items-center gap-5 bg-[color:var(--ah-band)] px-[18px] py-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-11"
					>
						<span className="min-w-0">
							<span
								className={cn(TYPE.groupLabel, 'text-primary mb-2.5 block')}
							>
								Up next · lesson {String(next.position).padStart(2, '0')}
							</span>
							<span className={cn(TYPE.panelTitle, 'block text-pretty')}>
								{next.title}
							</span>
						</span>
						{/* The spec's filled circular arrow: gold in dark, ink in light
						    (DESIGN rule 8's documented invert). */}
						<span
							aria-hidden
							className="text-background dark:bg-accent-fill dark:text-accent-fill-foreground bg-foreground ease-out-quart ml-auto flex size-11 flex-none items-center justify-center rounded-full transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
						>
							<ArrowRight className="size-5" />
						</span>
					</Link>
				)}
			</nav>
			{!hideLoginPrompt && next && !session?.user && <LoginToSaveProgress />}
		</>
	)
}
