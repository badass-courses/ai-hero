'use client'

import * as React from 'react'
import { Construction } from 'lucide-react'

/**
 * Admin-only "draft / unpublished" banner for pre-launch workshops. Consumes the
 * ability promise via `React.use` inside a Suspense boundary so the page shell
 * doesn't block on auth/DB just to decide whether to show it.
 */
export const WorkshopDraftBanner = ({
	abilityLoader,
	state,
	type,
}: {
	abilityLoader: Promise<{ canCreate?: boolean }>
	state?: string
	type?: string
}) => {
	const { canCreate } = React.use(abilityLoader)
	if (!canCreate) return null

	return (
		<div className="bg-stripes relative flex w-full items-center justify-center gap-2 border-b p-3 text-center">
			<Construction className="h-4 w-4" />{' '}
			<p className="text-sm font-medium capitalize">
				{state} {type}
			</p>
		</div>
	)
}
