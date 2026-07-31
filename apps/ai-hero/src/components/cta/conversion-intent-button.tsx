'use client'

import * as React from 'react'
import { completeKnownConversionIntent } from '@/lib/cta/conversion-intent-actions'
import type {
	ConversionSurface,
	GenericKnownConversionIntent,
} from '@/lib/cta/conversion-intent'

/**
 * One-click conversion control for a reader whose identity is already known.
 * Falls back through `onNotIdentified` when stale client identity cannot be
 * resolved on the server, so callers can render the ordinary email form.
 */
export function ConversionIntentButton({
	intent,
	surface,
	label,
	pendingLabel = 'Adding you…',
	className,
	onSuccess,
	onNotIdentified,
}: {
	intent: GenericKnownConversionIntent
	surface: ConversionSurface
	label: string
	pendingLabel?: string
	className?: string
	onSuccess?: (result: { confirmationRequired: boolean }) => void
	onNotIdentified?: () => void
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
						try {
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
							if (result.reason === 'not-identified') {
								onNotIdentified?.()
								return
							}
							setError('Something went wrong. Please try again.')
						} catch {
							setError('Something went wrong. Please try again.')
						}
					})
				}}
			>
				{isPending ? pendingLabel : label}
			</button>
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
		</div>
	)
}
