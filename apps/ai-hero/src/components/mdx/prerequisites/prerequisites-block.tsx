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
import { getCookie, setCookie } from 'cookies-next/client'
import { useInView } from 'framer-motion'

import { PrerequisitesRows as PrerequisitesView } from './prerequisites-rows'
import {
	PREREQUISITES_COOKIE,
	PREREQUISITES_COOKIE_MAX_AGE,
	readRemembered,
	writeRemembered,
	type Remembered,
} from './prerequisites-state'
import type { PrerequisiteItem } from './types'

function readCookie(hostLessonId?: string): Remembered {
	if (!hostLessonId) return {}
	try {
		return readRemembered(getCookie(PREREQUISITES_COOKIE), hostLessonId)
	} catch {
		return {}
	}
}

function writeCookie(hostLessonId: string | undefined, value: Remembered) {
	if (!hostLessonId) return
	try {
		setCookie(
			PREREQUISITES_COOKIE,
			writeRemembered(getCookie(PREREQUISITES_COOKIE), hostLessonId, value),
			{
				path: '/',
				maxAge: PREREQUISITES_COOKIE_MAX_AGE,
				sameSite: 'lax',
				secure: window.location.protocol === 'https:',
			},
		)
	} catch {
		// Cookies blocked: the choice lasts for this view only.
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
	initialRemembered,
}: {
	title: string
	/** Depth of the authored heading. */
	level: number
	items: PrerequisiteItem[]
	/** The lesson this block sits in; the collapse choice is kept per lesson. */
	hostLessonId?: string
	/**
	 * The cookie as the server read it for this request, so the first paint is
	 * already collapsed or open. Absent where the page doesn't read cookies.
	 */
	initialRemembered?: Remembered
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

	const [remembered, setRemembered] = useState<Remembered>(
		initialRemembered ?? {},
	)
	// The cookie is the truth on the client too. On hydration it matches the
	// server read, so nothing changes; on a back/forward navigation served from
	// the router cache the server read may be old, and this corrects it before
	// paint. Without a server read it is the only read.
	useBeforePaint(() => {
		const current = readCookie(hostLessonId)
		setRemembered((previous) =>
			previous.collapsed === current.collapsed &&
			previous.done === current.done
				? previous
				: current,
		)
	}, [hostLessonId])

	// Keep the last known completion so the next visit can start collapsed.
	useEffect(() => {
		if (!progressKnown) return
		setRemembered((current) => {
			// No entry reads as not done, so only a change is worth a cookie write.
			if ((current.done ?? false) === allCompleted) return current
			const next = { ...current, done: allCompleted }
			writeCookie(hostLessonId, next)
			return next
		})
	}, [progressKnown, allCompleted, hostLessonId])

	const onCollapsedChange = useCallback(
		(collapsed: boolean) => {
			setRemembered((current) => {
				const next = { ...current, collapsed }
				writeCookie(hostLessonId, next)
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
