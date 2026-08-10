'use client'

import { createAppAbility } from '@/ability'
import { api } from '@/trpc/react'
import { subject } from '@casl/ability'
import { useSession } from 'next-auth/react'

import { useWorkshopNavigation } from './workshop-navigation-provider'

export function useWorkshopAbility(lessonId?: string) {
	const workshopNavigation = useWorkshopNavigation()
	const { status: sessionStatus } = useSession()
	const query = api.ability.getCurrentAbilityRules.useQuery(
		{
			moduleId: workshopNavigation?.id,
			lessonId,
		},
		{
			enabled:
				sessionStatus === 'authenticated' && Boolean(workshopNavigation?.id),
			staleTime: 5 * 60 * 1000,
			refetchOnWindowFocus: false,
			retry: 1,
		},
	)
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
