'use client'

import { createAppAbility } from '@/ability'
import type { List } from '@/lib/lists'
import { api } from '@/trpc/react'

import { CreateListForm } from './create-list-form'
import { ListsTable } from './lists-table'

export function PersonalizedLists({ lists }: { lists: List[] }) {
	const { data: abilityRules, status } =
		api.ability.getCurrentAbilityRules.useQuery()
	const canCreateContent =
		status === 'success' &&
		createAppAbility(abilityRules ?? []).can('create', 'Content')

	return (
		<div className="flex flex-col gap-5">
			<ListsTable canCreateContent={canCreateContent} lists={lists} />
			{canCreateContent ? <CreateListForm /> : null}
		</div>
	)
}
