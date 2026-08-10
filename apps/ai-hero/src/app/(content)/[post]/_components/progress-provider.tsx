'use client'

import React from 'react'
import { api } from '@/trpc/react'
import { flattenListResources } from '@/utils/get-nextup-resource-from-list'

import type { ModuleProgress } from '@coursebuilder/core/schemas'
import { moduleProgressSchema } from '@coursebuilder/core/schemas'

import { useList } from './list-provider'

type ProgressContextType = {
	progress: ModuleProgress | null
	removeLessonProgress: (lessonId: string) => void
	addLessonProgress: (lessonId: string) => void
	/** Undo a failed optimistic add — see the overlay's `retract`. */
	rollbackLessonProgress: (lessonId: string) => void
}

const ProgressContext = React.createContext<ProgressContextType>({
	progress: null,
	removeLessonProgress: () => {},
	addLessonProgress: () => {},
	rollbackLessonProgress: () => {},
})

type CompletionOverlaySnapshot = {
	added: string[]
	removed: string[]
}

/**
 * Optimistic completions, held OUTSIDE the component tree.
 *
 * The `[post]` segment is keyed by its param, so advancing to the next post
 * remounts this provider — component state cannot carry a just-clicked tick
 * across the navigation. Worse, the next page's server-loaded progress races
 * the completion write the click fired (and may even be a stale prefetch), so
 * reseeding from the server alone drops the tick the reader just earned.
 *
 * Module scope is the one client-side place that outlives the segment. Every
 * completion surface lays this overlay over whatever data it holds — and the
 * overlay is deliberately NEVER dropped when a fresh server value agrees with
 * it. Surfaces disagree about freshness (the provider reloads per navigation;
 * the sidebar's Skills entry keeps a long-staleTime React Query copy), so
 * "the server confirmed it" is only true for one surface at a time — an
 * eager cleanup here made the sidebar's tick vanish the moment the provider's
 * fresh load arrived. The merge is idempotent, entries are bounded by the
 * reader's own clicks, and the whole store resets on a full page load.
 */
export function createCompletionOverlay() {
	const added = new Set<string>()
	const removed = new Set<string>()
	const listeners = new Set<() => void>()
	let snapshot: CompletionOverlaySnapshot = { added: [], removed: [] }
	const emit = () => {
		snapshot = { added: [...added], removed: [...removed] }
		for (const listener of listeners) listener()
	}
	return {
		/** Optimistically complete: also cancels a pending optimistic removal. */
		add(id: string) {
			removed.delete(id)
			added.add(id)
			emit()
		},
		/** Optimistically un-complete: masks the id even if the server reports it. */
		remove(id: string) {
			added.delete(id)
			removed.add(id)
			emit()
		},
		/**
		 * Roll back a failed optimistic add WITHOUT asserting un-completion.
		 * A rollback records no `removed` mask: the client cannot tell a failed
		 * write from a succeeded write behind a transport error, and a mask
		 * would hide a genuinely-landed completion for the rest of the session.
		 * Retracting only the add lets the next server fetch tell the truth.
		 */
		retract(id: string) {
			if (added.delete(id)) emit()
		},
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: () => snapshot,
	}
}

const completionOverlay = createCompletionOverlay()

/** Server render has no local clicks; must be referentially stable. */
const EMPTY_OVERLAY: CompletionOverlaySnapshot = { added: [], removed: [] }

/**
 * Live view of the optimistic completion overlay, for completion surfaces
 * that live OUTSIDE the provider — the sidebar's Skills entry keeps its own
 * React-Query copy of the skills-list progress, and without the overlay a
 * tick earned by "Next skill" would sit invisible behind its staleTime.
 */
export function useCompletionOverlay() {
	return React.useSyncExternalStore(
		completionOverlay.subscribe,
		completionOverlay.getSnapshot,
		() => EMPTY_OVERLAY,
	)
}

const emptyProgress = () =>
	moduleProgressSchema.parse({
		completedLessons: [],
		nextResource: null,
		percentCompleted: 0,
		completedLessonsCount: 0,
		totalLessonsCount: 0,
	})

/**
 * Lay the optimistic overlay over the server-loaded progress.
 *
 * `memberIds` scopes it to the current list: the overlay is global to the
 * browser session, and an id completed in some other module must not inflate
 * this one's counts (it becomes visible where it belongs, on that module's
 * own pages). `null` means no membership to scope by — a standalone post's
 * progress module is the post itself, and filtering against an empty set
 * there silently dropped the reader's own optimistic tick.
 */
export function applyCompletionOverlay(
	progress: ModuleProgress | null,
	memberIds: ReadonlySet<string> | null,
	{ added, removed }: CompletionOverlaySnapshot,
): ModuleProgress | null {
	const addedHere = added.filter(
		(id) =>
			(memberIds?.has(id) ?? true) &&
			!progress?.completedLessons.some((l) => l.resourceId === id),
	)
	const removedHere = removed.filter(
		(id) =>
			(memberIds?.has(id) ?? true) &&
			progress?.completedLessons.some((l) => l.resourceId === id),
	)
	if (addedHere.length === 0 && removedHere.length === 0) return progress

	const base = progress ?? emptyProgress()
	const completedLessons = [
		...base.completedLessons.filter(
			(lesson) =>
				!lesson.resourceId || !removedHere.includes(lesson.resourceId),
		),
		...addedHere.map((resourceId) => ({
			resourceId,
			completedAt: new Date(),
			userId: '',
		})),
	]
	return {
		...base,
		completedLessons,
		completedLessonsCount: completedLessons.length,
		// Derived values must follow the merged count — a progress bar or the
		// `=== 100` certificate unlock reading the same object would otherwise
		// disagree with the ticks. Math.ceil to match the server adapter (and
		// `module-progress-provider`, which keeps the same invariant); with no
		// known total the server's value is the only honest one.
		percentCompleted:
			base.totalLessonsCount > 0
				? Math.ceil((completedLessons.length / base.totalLessonsCount) * 100)
				: base.percentCompleted,
	}
}

/**
 * ProgressProvider exposes the completion state of lessons within the current
 * module/list, blending two sources:
 *
 * - a client query for server-loaded progress. Progress is per-user data, so
 *   reading it in the post layout also reads the auth headers and opts every
 *   post out of prerendering. The query starts as soon as this provider
 *   hydrates and leaves the shared static shell anonymous.
 * - the module-scoped completion overlay (see `createCompletionOverlay`),
 *   which carries optimistic ticks across the per-navigation remount of this
 *   provider and wins any race with the server value.
 *
 * @param moduleId - List id, or the post slug for a standalone post.
 * @param children - React child components that will have access to progress context
 */
export function ProgressProvider({
	moduleId,
	children,
}: {
	moduleId: string
	children: React.ReactNode
}) {
	const { data: initialProgress = null } =
		api.progress.getModuleProgressForUser.useQuery(
			{ moduleId },
			{
				staleTime: 5 * 60 * 1000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)
	const { list } = useList()
	const overlay = useCompletionOverlay()

	// `null`, not an empty set, when there is no list: a standalone post's
	// progress module is the post itself, and an empty membership would filter
	// the reader's own optimistic tick out of it.
	const memberIds = React.useMemo(
		() =>
			list
				? new Set(
						flattenListResources(list)
							.map((wrapper) => wrapper.resource?.id)
							.filter((id): id is string => typeof id === 'string'),
					)
				: null,
		[list],
	)

	const progress = React.useMemo(
		() => applyCompletionOverlay(initialProgress, memberIds, overlay),
		[initialProgress, memberIds, overlay],
	)

	const addLessonProgress = React.useCallback((lessonId: string) => {
		completionOverlay.add(lessonId)
	}, [])
	const removeLessonProgress = React.useCallback((lessonId: string) => {
		completionOverlay.remove(lessonId)
	}, [])
	const rollbackLessonProgress = React.useCallback((lessonId: string) => {
		completionOverlay.retract(lessonId)
	}, [])

	return (
		<ProgressContext.Provider
			value={{
				progress,
				removeLessonProgress,
				addLessonProgress,
				rollbackLessonProgress,
			}}
		>
			{children}
		</ProgressContext.Provider>
	)
}

export function useProgress() {
	return React.useContext(ProgressContext)
}
