'use client'

import Link from 'next/link'
import { createAppAbility } from '@/ability'
import { api } from '@/trpc/react'

import { Button } from '@coursebuilder/ui'

export function SkillChangelogActionBar({
	entryId,
	entrySlug,
}: {
	entryId: string
	entrySlug?: string | null
}) {
	const { data: abilityRules, status } =
		api.ability.getCurrentAbilityRules.useQuery()

	if (status !== 'success') return null

	const ability = createAppAbility(abilityRules ?? [])
	if (ability.cannot('update', 'Content')) return null

	return (
		<Button asChild size="sm" className="absolute right-0 top-0 z-50">
			<Link href={`/skills/${entrySlug || entryId}/edit`}>Edit</Link>
		</Button>
	)
}
