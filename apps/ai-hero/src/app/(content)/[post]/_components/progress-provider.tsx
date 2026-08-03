'use client'

import React from 'react'
import { flattenListResources } from '@/utils/get-nextup-resource-from-list'

import type { ModuleProgress } from '@coursebuilder/core/schemas'
import { moduleProgressSchema } from '@coursebuilder/core/schemas'

import { useList } from './list-provider'

type ProgressContextType = {
	progress: ModuleProgress | null
	removeLessonProgress: (lessonId: string) => void
	addLessonProgress: (lessonId: string) => void
}

const ProgressContext = React.createContext<ProgressContextType>({
	progress: null,
	removeLessonProgress: () => {},
	addLessonProgress: () => {},
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
		/** Optimistically un-complete: also rolls back a pending optimistic add. */
		remove(id: string) {
			added.delete(id)
			removed.add(id)
			emit()
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
 * own pages).
 */
export function applyCompletionOverlay(
	progress: ModuleProgress | null,
	memberIds: ReadonlySet<string>,
	{ added, removed }: CompletionOverlaySnapshot,
): ModuleProgress | null {
	const addedHere = added.filter(
		(id) =>
			memberIds.has(id) &&
			!progress?.completedLessons.some((l) => l.resourceId === id),
	)
	const removedHere = removed.filter(
		(id) =>
			memberIds.has(id) &&
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
	}
}

/**
 * ProgressProvider exposes the completion state of lessons within the current
 * module/list, blending two sources:
 *
 * - `progressLoader`, a PROMISE of the server-loaded progress. Progress is the
 *   only per-user data on a post page, and the layout awaiting it meant the
 *   whole route rendered behind an auth read and a per-user query; unwrapping
 *   it here with `React.use()` lets that query run concurrently with the rest
 *   of the server render.
 * - the module-scoped completion overlay (see `createCompletionOverlay`),
 *   which carries optimistic ticks across the per-navigation remount of this
 *   provider and wins any race with the server value.
 *
 * @param progressLoader - Promise of the progress data, started (and error-handled) server-side
 * @param children - React child components that will have access to progress context
 */
export function ProgressProvider({
	progressLoader,
	children,
}: {
	progressLoader: Promise<ModuleProgress | null>
	children: React.ReactNode
}) {
	const initialProgress = React.use(progressLoader)
	const { list } = useList()
	const overlay = useCompletionOverlay()

	const memberIds = React.useMemo(
		() =>
			new Set(
				flattenListResources(list)
					.map((wrapper) => wrapper.resource?.id)
					.filter((id): id is string => typeof id === 'string'),
			),
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

	return (
		<ProgressContext.Provider
			value={{
				progress,
				removeLessonProgress,
				addLessonProgress,
			}}
		>
			{children}
		</ProgressContext.Provider>
	)
}

export function useProgress() {
	return React.useContext(ProgressContext)
}
