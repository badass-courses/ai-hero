'use client'

import { createAppAbility } from '@/ability'
import { api } from '@/trpc/react'
import { subject } from '@casl/ability'
import { useQuery } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { useSession } from 'next-auth/react'

import { useLessonAbilityScope } from './lesson-ability-seed'
import { useWorkshopNavigation } from './workshop-navigation-provider'

export function useWorkshopAbilityRules({
	moduleId,
	lessonId,
	workshopControls = false,
}: {
	moduleId?: string
	lessonId?: string
	workshopControls?: boolean
}) {
	const scope = useLessonAbilityScope()
	const { data: session, status: sessionStatus } = useSession()
	const userId = sessionStatus === 'authenticated' ? session?.user?.id : undefined
	const { client } = api.useUtils()
	// For workshop lesson/exercise/solution/post records the lesson-specific
	// branch only repeats a cohort grant already scoped to this same module.
	// Both consumers can use the page's input without unlocking more rows.
	const input = scope?.input ?? { moduleId, lessonId }
	const waitingForPage = scope?.waitingForPage ?? false
	const viewer = scope?.seed?.viewer
	const initialData = viewer?.id === userId ? viewer?.rules : undefined
	const key = getQueryKey(api.ability.getCurrentAbilityRules, input, 'query')
	const query = useQuery({
		// Keep tRPC's prefix (including input) for invalidation. The last part
		// isolates each viewer and keeps the waiting observer from creating the
		// real query before initialData is available.
		queryKey: [...key, waitingForPage ? null : userId],
		queryFn: ({ signal }) =>
			client.ability.getCurrentAbilityRules.query(input, { signal }),
		enabled: Boolean(userId && moduleId && !waitingForPage),
		initialData,
		// Either observer can refetch the shared query. Give the sidebar the
		// controls' refresh policy when the page supplied this viewer's rules.
		...((workshopControls || initialData !== undefined) && {
			staleTime: 5 * 60 * 1000,
			refetchOnWindowFocus: false,
		}),
		...(workshopControls && { retry: 1 }),
	})
	return { query, sessionStatus }
}

export function useWorkshopAbility() {
	const workshopNavigation = useWorkshopNavigation()
	const { query, sessionStatus } = useWorkshopAbilityRules({
		moduleId: workshopNavigation?.id,
		workshopControls: true,
	})
	const ability = createAppAbility(query.data ?? [])

	return {
		...query,
		status: sessionStatus === 'unauthenticated' ? 'success' : query.status,
		ability,
		canCreate: ability.can('create', 'Content'),
		canViewWorkshop: workshopNavigation
			? ability.can('read', subject('Content', { id: workshopNavigation.id }))
			: false,
		isPendingOpenAccess: ability.can('read', 'PendingOpenAccess'),
	}
}
