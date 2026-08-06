'use client'

import * as React from 'react'
import { type ConversionSurface } from '@/lib/cta/conversion-intent'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/ui/utils/cn'

import { addWorkshopInterest } from './workshop-interest-actions'
import { syncWorkshopInterestGate } from './workshop-interest-gate'

export function WorkshopInterestButton({
	workshopSlug,
	surface = 'workshop-page',
	className,
	containerClassName,
	children = 'Keep me posted',
	pendingChildren = 'Adding you…',
	onSuccess,
}: {
	workshopSlug: string
	/** Attribution only. The field and tag written are the same either way. */
	surface?: ConversionSurface
	className?: string
	containerClassName?: string
	children?: React.ReactNode
	pendingChildren?: React.ReactNode
	onSuccess?: () => void
}) {
	const [isPending, startTransition] = React.useTransition()
	const [error, setError] = React.useState(false)
	const utils = api.useUtils()

	return (
		<div className={cn('inline-flex flex-col gap-2', containerClassName)}>
			<button
				type="button"
				onClick={() => {
					setError(false)
					startTransition(async () => {
						const result = await addWorkshopInterest(workshopSlug, surface)
						if (result.success && result.gate) {
							syncWorkshopInterestGate({
								gate: result.gate,
								setGate: (gate) =>
									utils.ability.getSubscriberForCtaGating.setData(
										undefined,
										gate,
									),
								refreshGate: () =>
									utils.ability.getSubscriberForCtaGating.invalidate(),
							})
							track('subscribed', {
								location: 'workshop_interest_existing',
								workshop: workshopSlug,
							})
							onSuccess?.()
						} else {
							setError(true)
						}
					})
				}}
				disabled={isPending}
				className={className}
			>
				{isPending ? pendingChildren : children}
			</button>
			{error ? (
				<p className="text-destructive text-sm">
					Something went wrong. Please try again.
				</p>
			) : null}
		</div>
	)
}
