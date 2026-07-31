'use client'

import * as React from 'react'
import { completeKnownConversionIntent } from '@/lib/cta/conversion-intent-actions'
import type {
	ConversionSurface,
	GenericKnownConversionIntent,
} from '@/lib/cta/conversion-intent'

export function ConversionIntentButton({
	intent,
	surface,
	label,
	pendingLabel = 'Adding you…',
	className,
	onSuccess,
}: {
	intent: GenericKnownConversionIntent
	surface: ConversionSurface
	label: string
	pendingLabel?: string
	className?: string
	onSuccess?: (result: { confirmationRequired: boolean }) => void
}) {
	const [isPending, startTransition] = React.useTransition()
	const [error, setError] = React.useState<string | null>(null)

	return (
		<div className="flex w-full flex-col gap-2">
			<button
				type="button"
				disabled={isPending}
				className={className}
				onClick={() => {
					setError(null)
					startTransition(async () => {
						const result = await completeKnownConversionIntent({
							intent,
							surface,
						})
						if (result.success) {
							onSuccess?.({
								confirmationRequired: result.confirmationRequired,
							})
							return
						}
						setError('Something went wrong. Please try again.')
					})
				}}
			>
				{isPending ? pendingLabel : label}
			</button>
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
		</div>
	)
}
