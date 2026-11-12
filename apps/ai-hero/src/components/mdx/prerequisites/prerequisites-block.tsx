'use client'

import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { ActiveHeadingContext } from '@/hooks/use-active-heading'
import { api } from '@/trpc/react'
import { slugifyHeading } from '@/utils/extract-markdown-headings'
import { useInView } from 'framer-motion'

import type { PrerequisiteItem } from './types'
import { PrerequisitesRows as PrerequisitesView } from './prerequisites-rows'

/**
 * What this browser remembers per host lesson: the learner's own collapse
 * choice, and whether every prerequisite was done last time. The second one
 * lets a returning learner's block start collapsed at hydration instead of
 * waiting for the progress read.
 */
type Remembered = { collapsed?: boolean; done?: boolean }

const storageKey = (hostLessonId: string) =>
	`ah:prerequisites:${hostLessonId}`

function readRemembered(hostLessonId?: string): Remembered {
	if (!hostLessonId) return {}
	try {
		const raw = window.localStorage.getItem(storageKey(hostLessonId))
		const value = raw ? JSON.parse(raw) : null
		if (!value || typeof value !== 'object') return {}
		return {
			collapsed:
				typeof value.collapsed === 'boolean' ? value.collapsed : undefined,
			done: typeof value.done === 'boolean' ? value.done : undefined,
		}
	} catch {
		return {}
	}
}

function writeRemembered(hostLessonId: string | undefined, value: Remembered) {
	if (!hostLessonId) return
	try {
		window.localStorage.setItem(
			storageKey(hostLessonId),
			JSON.stringify(value),
		)
	} catch {
		// Private mode or blocked storage: the choice lasts for this view only.
	}
}

// Before paint on the client; a no-op warning-free effect on the server.
const useBeforePaint =
	typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * The block replaces an authored heading that the lesson's table of contents
 * still lists (the ToC reads the raw markdown). It keeps that entry working:
 * the wrapper carries the heading's anchor id and reports itself to the
 * active-heading tracker, exactly as the `Heading` it stands in for would.
 */
function useHeadingStandIn(title: string, level: number) {
	const ref = useRef<HTMLDivElement>(null)
	const slug = slugifyHeading(title)
	const isInView = useInView(ref, { amount: 0, margin: '-80px 0px -40% 0px' })
	const registerVisibility = useContext(ActiveHeadingContext)?.registerVisibility
	const heading = useMemo(
		() => ({ slug, text: title, level }),
		[slug, title, level],
	)
	useEffect(() => {
		if (!registerVisibility) return
		registerVisibility(heading, isInView)
		return () => registerVisibility(heading, false)
	}, [heading, isInView, registerVisibility])
	return { ref, slug }
}

export function PrerequisitesBlock({
	title,
	level,
	items,
	hostLessonId,
}: {
	title: string
	/** Depth of the authored heading. */
	level: number
	items: PrerequisiteItem[]
	/** The lesson this block sits in; the collapse choice is kept per lesson. */
	hostLessonId?: string
}) {
	// Real progress, not a snapshot: the client defaults (staleTime 0) refetch
	// on mount, which covers a back navigation, and on focus/visibility, which
	// covers a lesson completed in another tab. Completion writes in this tab
	// also invalidate it (`useSetLessonCompleted`).
	const { data: completedIds } = api.progress.completedOf.useQuery(
		{ resourceIds: items.map((item) => item.lessonId) },
		{ retry: 1 },
	)
	const progressKnown = Array.isArray(completedIds)
	const completed = new Set(completedIds ?? [])
	const viewItems = items.map((item) => ({
		...item,
		completed: progressKnown && completed.has(item.lessonId),
	}))
	const completedCount = viewItems.filter((item) => item.completed).length
	const allCompleted = progressKnown && completedCount === items.length

	const [remembered, setRemembered] = useState<Remembered>({})
	useBeforePaint(() => {
		setRemembered(readRemembered(hostLessonId))
	}, [hostLessonId])

	// Keep the last known completion so the next visit can start collapsed.
	useEffect(() => {
		if (!progressKnown) return
		setRemembered((current) => {
			if (current.done === allCompleted) return current
			const next = { ...current, done: allCompleted }
			writeRemembered(hostLessonId, next)
			return next
		})
	}, [progressKnown, allCompleted, hostLessonId])

	const onCollapsedChange = useCallback(
		(collapsed: boolean) => {
			setRemembered((current) => {
				const next = { ...current, collapsed }
				writeRemembered(hostLessonId, next)
				return next
			})
		},
		[hostLessonId],
	)

	const collapsed =
		remembered.collapsed ??
		(progressKnown ? allCompleted : (remembered.done ?? false))

	const anchor = useHeadingStandIn(title, level)

	return (
		<div
			ref={anchor.ref}
			id={anchor.slug}
			data-heading-slug={anchor.slug}
			className="scroll-mt-[72px]"
		>
			<PrerequisitesView
				title={title}
				items={viewItems}
				completedCount={completedCount}
				allCompleted={allCompleted}
				progressKnown={progressKnown}
				collapsed={collapsed}
				onCollapsedChange={onCollapsedChange}
			/>
		</div>
	)
}
