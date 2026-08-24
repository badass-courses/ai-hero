'use client'

import { Construction } from 'lucide-react'

import { useWorkshopAbility } from './use-workshop-ability'

/**
 * Admin-only "draft / unpublished" banner. The editor ability arrives after
 * hydration so the prerendered shell never reads a session.
 */
export const WorkshopDraftBanner = ({
	state,
	type,
}: {
	state?: string
	type?: string
}) => {
	const { canCreate, status } = useWorkshopAbility()
	if (status !== 'success' || !canCreate) return null

	return (
		<div className="bg-stripes relative flex w-full items-center justify-center gap-2 border-b p-3 text-center">
			<Construction className="h-4 w-4" />{' '}
			<p className="text-sm font-medium capitalize">
				{state} {type}
			</p>
		</div>
	)
}
