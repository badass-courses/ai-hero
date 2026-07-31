'use client'

import type { ReactElement, ReactNode } from 'react'
import {
	SubscribeToConvertkitForm,
	type SubscribeFormProps,
} from '@/convertkit'
import { finalizeAnonymousConversionIntent } from '@/lib/cta/conversion-intent-actions'
import {
	conversionIntentContract,
	type ConversionIntent,
	type ConversionSurface,
} from '@/lib/cta/conversion-intent'
import type { Subscriber } from '@/schemas/subscriber'

type ConversionIntentFormProps = Omit<
	SubscribeFormProps,
	'fields' | 'formId' | 'onSuccess'
> & {
	intent: ConversionIntent
	surface: ConversionSurface
	onSuccess?: (subscriber?: Subscriber, email?: string) => void | Promise<void>
	successMessage?: string | ReactElement
	children?: ReactNode
}

/**
 * The only form migrated conversion surfaces render.
 *
 * Presentation props remain local. Marketing state does not: form id, fields,
 * source, and tags all come from the intent contract.
 */
export function ConversionIntentForm({
	intent,
	surface,
	onSuccess,
	...props
}: ConversionIntentFormProps) {
	const contract = conversionIntentContract({ intent, surface })

	return (
		<SubscribeToConvertkitForm
			{...props}
			formId={contract.formId}
			fields={contract.fields}
				onSuccess={async (subscriber, email) => {
					if (email && contract.tagName) {
						// Primary fields were already accepted by Kit. Projection failure is
						// logged server-side and must not tell the reader the signup failed.
						await finalizeAnonymousConversionIntent({
							intent,
							surface,
							email,
						}).catch(() => undefined)
				}
				await onSuccess?.(subscriber, email)
			}}
		/>
	)
}
