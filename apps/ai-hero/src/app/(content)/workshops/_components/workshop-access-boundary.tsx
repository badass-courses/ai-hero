'use client'

import type { ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'

import { readCommerceUrlParams } from './commerce-url-params'
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

/** Lets `?allowPurchase=true` replace a pre-launch waitlist after hydration. */
export function WorkshopSidebarAccessBoundary({
	anonymous,
	member,
	forcedPurchase,
}: {
	anonymous: ReactNode
	member: ReactNode
	forcedPurchase: ReactNode
}) {
	const { forceAllowPurchase } = readCommerceUrlParams(useSearchParams())

	if (forceAllowPurchase) return forcedPurchase

	return <WorkshopAccessBoundary anonymous={anonymous} member={member} />
}
