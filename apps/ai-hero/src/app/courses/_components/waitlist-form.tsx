'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import type { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The waitlist capture that lives inside the /courses hero.
 *
 * It is the site's ordinary Kit form wearing the redesign's clothes, not a
 * second list: stacking name / email / submit is what the 400px hero rail
 * affords, and the handoff's inline variant is the thing that overflowed its
 * card twice during design. `min-w-0` on the form and its fieldsets plus
 * `box-border` on the inputs is the fix that note asks for — without it a
 * `w-full` input adds its border and padding *outside* the track and pushes
 * the rail wider than 400px between 900 and 1100px.
 *
 * Labels are `sr-only` rather than hidden: the placeholders carry the visual
 * label, and a hidden `<label>` would take the accessible name with it.
 */
export function WaitlistForm({ actionLabel }: { actionLabel: string }) {
	const router = useRouter()

	return (
		<SubscribeToConvertkitForm
			id="courses-waitlist"
			actionLabel={actionLabel}
			onSuccess={(subscriber) => {
				if (!subscriber) return
				track('courses_waitlist_subscribed')
				router.push(redirectUrlBuilder(subscriber as Subscriber, '/confirm'))
			}}
			className={cn(
				TYPE.meta,
				'flex w-full min-w-0 flex-col gap-2.5',
				'[&_[data-sr-fieldset]]:min-w-0',
				'[&_label]:sr-only',
				'[&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_input]:focus-visible:ring-ring [&_input]:box-border [&_input]:h-11 [&_input]:w-full [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm',
				'[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:h-[46px] [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:text-sm [&_button]:font-bold [&_button]:shadow-none',
			)}
		/>
	)
}
