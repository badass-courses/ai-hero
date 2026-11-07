'use client'

import Link from 'next/link'
import { api } from '@/trpc/react'
import { FLAGSHIP_RUNNING } from '@/lib/courses-content'
import { useSession } from 'next-auth/react'

import { FEATURED_PROMO } from './navigation/promo-config'

const C5_COHORT_HREF =
	FEATURED_PROMO.navHref ?? '/cohorts/software-factories-for-real-engineers-xdy1m'

/**
 * Where the C5 hero button goes. A buyer was asked to "Join the cohort" on the
 * home page and /courses after enrolling, and could not tell whether he was
 * signed in (cnv_1olvagx1). Only a confirmed `owned: true` changes the
 * button: unknown or failed ownership keeps the sale link, the same safe
 * direction the nav takes.
 */
export function c5JoinLink(
	owned: boolean | undefined,
	saleHref: string,
): { href: string; label: string } {
	return owned === true
		? { href: C5_COHORT_HREF, label: FLAGSHIP_RUNNING.ctaLabel }
		: { href: saleHref, label: 'Join the cohort' }
}

/** The C5 "Join the cohort" button, which becomes "Go to the cohort" for owners. */
export function C5JoinCta({
	href,
	className,
}: {
	href: string
	className?: string
}) {
	const { status } = useSession()
	const resourceId = FEATURED_PROMO.resourceId ?? ''
	// Same query and options as the nav's ownership check, so they share one
	// cached request. Signed-out readers own nothing and cost no query.
	const { data } = api.ability.ownsResource.useQuery(
		{ resourceId },
		{
			enabled: Boolean(resourceId) && status !== 'unauthenticated',
			staleTime: 5 * 60 * 1000,
			refetchOnWindowFocus: false,
			retry: 1,
		},
	)
	const link = c5JoinLink(data?.owned, href)

	return (
		<Link href={link.href} className={className}>
			{link.label}
		</Link>
	)
}
