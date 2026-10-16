'use client'

import type { ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import { readCommerceUrlParams } from './commerce-url-params'
import { useWorkshopAbility } from './use-workshop-ability'

export type WorkshopAccessView = 'anonymous' | 'member' | 'pending' | 'error'

/**
 * Picks the branch for a viewer. Signed-out viewers keep the anonymous sales
 * content (SSR and SEO). A signed-in viewer never sees the buy branch until
 * their ability has actually resolved: loading and failure are not "unowned".
 */
export function workshopAccessView({
	signedIn,
	status,
	canViewWorkshop,
}: {
	signedIn: boolean
	status: 'pending' | 'error' | 'success'
	canViewWorkshop: boolean
}): WorkshopAccessView {
	if (!signedIn) return 'anonymous'
	if (status === 'pending') return 'pending'
	if (status === 'error') return 'error'
	return canViewWorkshop ? 'member' : 'anonymous'
}

/** Draws the anonymous-safe branch until the viewer's ability resolves. */
export function WorkshopAccessBoundary({
	anonymous,
	member,
}: {
	anonymous: ReactNode
	member: ReactNode
}) {
	const { canViewWorkshop, status } = useWorkshopAbility()
	// Signed-in state comes from the session, never from the ability fetch.
	const { status: sessionStatus } = useSession()
	const view = workshopAccessView({
		signedIn: sessionStatus === 'authenticated',
		status,
		canViewWorkshop,
	})

	switch (view) {
		case 'member':
			return member
		case 'pending':
			return null
		case 'error':
			return (
				<p role="status" className="text-muted-foreground text-sm">
					We couldn&apos;t check your access just now. Refresh to try again.
				</p>
			)
		default:
			return anonymous
	}
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
