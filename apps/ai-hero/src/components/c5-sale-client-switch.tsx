'use client'

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import { FEATURED_PROMO } from './navigation/promo-config'
import { useTimedActivation } from './navigation/timed-promo-bar-switch'

/** One deduplicated read for cached server surfaces, not a second scheduler. */
export function C5SaleClientSwitch({
	children,
	fallback,
	pricingClosed,
	initialFeaturedActive,
}: {
	children: ReactNode
	fallback: ReactNode
	pricingClosed: boolean
	initialFeaturedActive: boolean
}) {
	const active = useTimedActivation(FEATURED_PROMO, initialFeaturedActive)
	const status = useQuery({
		queryKey: ['c5-site-promo'],
		queryFn: async () => {
			const response = await fetch('/api/c5-site-promo', { cache: 'no-store' })
			if (!response.ok) throw new Error('C5 promo switch unavailable')
			const body = await response.json()
			// Malformed or unavailable state must never open the promotion.
			return { pricingClosed: body.pricingClosed !== false }
		},
		initialData: { pricingClosed },
		enabled: active,
		refetchOnMount: 'always',
		refetchOnWindowFocus: 'always',
		retry: false,
	})

	return active && !status.isError && !status.data.pricingClosed
		? children
		: fallback
}
