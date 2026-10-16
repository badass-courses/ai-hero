'use client'

import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { TYPE } from '@/components/landing/type'
import type { AnalyticsRange } from '@/lib/analytics'
import {
	EVERGREEN_FUNNEL_PENDING,
	type Pending,
	type PromoRevenue,
} from '@/lib/analytics/promos'

/** Query owns loading -> success/error and cancellation on range changes. */
export function EvergreenOfferCard({ range }: { range: AnalyticsRange }) {
	const revenue = useQuery({
		queryKey: ['analytics', 'revenue/promos', range],
		enabled: range !== 'all',
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		queryFn: async ({ signal }) => {
			const response = await fetch(
				`/api/analytics?surface=revenue%2Fpromos&range=${encodeURIComponent(range)}`,
				{ signal, cache: 'no-store' },
			)
			const body = await response.json()
			if (!response.ok || !body.ok)
				throw new Error('Evergreen revenue is temporarily unavailable.')
			return body.data as PromoRevenue
		},
		retry: false,
	})
	const conversion: Pending = EVERGREEN_FUNNEL_PENDING
	const evergreen = revenue.data?.byKind.find((row) => row.kind === 'evergreen')
	return (
		<section
			aria-label="Evergreen offer"
			className="bg-card text-card-foreground border-border rounded-lg border p-4"
		>
			<h2 className={TYPE.cardTitle}>Evergreen offer</h2>
			<div
				className={`${TYPE.meta} text-muted-foreground mt-2`}
				aria-live="polite"
			>
				<p>All products</p>
				{range === 'all' ? (
					'Choose a bounded range to view evergreen revenue.'
				) : revenue.isPending ? (
					'Loading evergreen revenue…'
				) : revenue.isError ? (
					'Evergreen revenue is temporarily unavailable.'
				) : evergreen ? (
					<p>
						{new Intl.NumberFormat('en-US', {
							style: 'currency',
							currency: revenue.data.currency,
						}).format(evergreen.net)}{' '}
						net · {evergreen.purchaseCount} purchases (incl. refunded)
					</p>
				) : (
					'Evergreen revenue is temporarily unavailable.'
				)}
				<p title={conversion.reason}>Conversion: {conversion.status}</p>
			</div>
		</section>
	)
}
