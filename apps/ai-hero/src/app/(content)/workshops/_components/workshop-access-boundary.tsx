'use client'

import type { ReactNode } from 'react'

import { useWorkshopAbility } from './use-workshop-ability'

/** Draws the anonymous-safe branch until the viewer's ability resolves. */
export function WorkshopAccessBoundary({
	anonymous,
	member,
}: {
	anonymous: ReactNode
	member: ReactNode
}) {
	const { canViewWorkshop, status } = useWorkshopAbility()

	return status === 'success' && canViewWorkshop ? member : anonymous
}
