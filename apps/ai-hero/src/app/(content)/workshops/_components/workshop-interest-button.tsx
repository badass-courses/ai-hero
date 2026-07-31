'use client'

import * as React from 'react'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/ui/utils/cn'

import { addWorkshopInterest } from './workshop-interest-actions'

export function WorkshopInterestButton({
	workshopSlug,
	className,
	containerClassName,
	children = 'Keep me posted',
	pendingChildren = 'Adding you…',
	onSuccess,
}: {
	workshopSlug: string
	className?: string
	containerClassName?: string
	children?: React.ReactNode
	pendingChildren?: React.ReactNode
	onSuccess?: () => void
}) {
	const [isPending, startTransition] = React.useTransition()
	const [error, setError] = React.useState(false)

	return (
		<div className={cn('inline-flex flex-col gap-2', containerClassName)}>
			<button
				type="button"
				onClick={() => {
					setError(false)
					startTransition(async () => {
						const result = await addWorkshopInterest(workshopSlug)
						if (result.success) {
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
