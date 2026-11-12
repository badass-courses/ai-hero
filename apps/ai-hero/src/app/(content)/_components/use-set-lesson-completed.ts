'use client'

import { useCallback } from 'react'
import { api } from '@/trpc/react'

/**
 * The tRPC `progress.setCompleted` write, for every client completion path
 * (manual toggle, video end, end card, Up Next). Once the write settles it
 * invalidates `progress.completedOf`, so a lesson's prerequisites block shows
 * the change when the learner navigates back to it in the same tab.
 *
 * tRPC rather than a server action: the router queues server actions with
 * navigations, and one settling mid-navigation replays the old page.
 */
export function useSetLessonCompleted() {
	const utils = api.useUtils()
	return useCallback(
		(input: { resourceId: string; isCompleted: boolean }) =>
			utils.client.progress.setCompleted.mutate(input).finally(() => {
				void utils.progress.completedOf.invalidate()
			}),
		[utils],
	)
}
