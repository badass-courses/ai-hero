'use client'

import type { ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import { readCommerceUrlParams } from './commerce-url-params'
import { useWorkshopAbility } from './use-workshop-ability'

export type WorkshopAccessView = 'anonymous' | 'member' | 'pending' | 'error'

export type WorkshopAccessInput = {
	/** From `useSession`, never inferred from the ability fetch. */
	sessionStatus: 'loading' | 'authenticated' | 'unauthenticated'
	/** The ability query's status (the hook reports `success` when signed out). */
	status: 'pending' | 'error' | 'success'
	/** `idle` on a pending query means it is disabled: there is no check to wait for. */
	fetchStatus: 'fetching' | 'paused' | 'idle'
	/** The ability query holds rules from an earlier success. */
	hasData: boolean
	canViewWorkshop: boolean
}

/**
 * Picks the branch for a viewer. Only a confirmed signed-out viewer gets the
 * buy branch. The root `SessionProvider` is unseeded and the page is static, so
 * the session is `loading` on first paint: until the session and ability are
 * known, nobody is shown a buy ask (`pending`), and a failed check is `error`,
 * not "unowned".
 */
export function workshopAccessView({
	sessionStatus,
	status,
	fetchStatus,
	hasData,
	canViewWorkshop,
}: WorkshopAccessInput): WorkshopAccessView {
	if (sessionStatus === 'unauthenticated') return 'anonymous'
	if (sessionStatus === 'loading') return 'pending'
	// Signed in. A refetch error keeps the rules we already have.
	if (status === 'error' && !hasData) return 'error'
	if (status === 'pending') {
		return fetchStatus === 'idle' ? 'anonymous' : 'pending'
	}
	return canViewWorkshop ? 'member' : 'anonymous'
}

/**
 * Draws the branch for the viewer's access. `anonymousWithoutCta` is the same
 * sales content minus any buy or notify ask; it is what renders (and ships in
 * the static HTML) until the viewer is known not to own the workshop.
 */
export function WorkshopAccessBoundary({
	anonymous,
	anonymousWithoutCta,
	member,
	showErrorNote = false,
}: {
	anonymous: ReactNode
	anonymousWithoutCta: ReactNode
	member: ReactNode
	/** Only the sidebar slot says so; inline mounts fail quietly to no ask. */
	showErrorNote?: boolean
}) {
	const { canViewWorkshop, status, fetchStatus, data } = useWorkshopAbility()
	const { status: sessionStatus } = useSession()
	const view = workshopAccessView({
		sessionStatus,
		status,
		fetchStatus,
		hasData: data !== undefined,
		canViewWorkshop,
	})

	switch (view) {
		case 'member':
			return member
		case 'pending':
			return anonymousWithoutCta
		case 'error':
			if (!showErrorNote) return anonymousWithoutCta
			return (
				<>
					{anonymousWithoutCta}
					<p role="status" className="text-muted-foreground p-3 text-sm">
						We couldn&apos;t check your access just now. Refresh to try again.
					</p>
				</>
			)
		default:
			return anonymous
	}
}

/** Lets `?allowPurchase=true` replace a pre-launch waitlist after hydration. */
export function WorkshopSidebarAccessBoundary({
	anonymous,
	anonymousWithoutCta,
	member,
	forcedPurchase,
}: {
	anonymous: ReactNode
	anonymousWithoutCta: ReactNode
	member: ReactNode
	forcedPurchase: ReactNode
}) {
	const { forceAllowPurchase } = readCommerceUrlParams(useSearchParams())

	if (forceAllowPurchase) return forcedPurchase

	return <WorkshopAccessBoundary
			anonymous={anonymous}
			anonymousWithoutCta={anonymousWithoutCta}
			member={member}
			showErrorNote
		/>
}
