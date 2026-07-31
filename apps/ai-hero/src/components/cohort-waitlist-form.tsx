'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import type { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The cohort waitlist capture. One form, one Kit list, two callers: the
 * `/courses` hero and the homepage's cohort block.
 *
 * It is shared on purpose. Amy's note on the homepage block — *"might as well
 * include the signup form"* — and her note on the `/courses` hero are the same
 * note, and two cohort asks that behave differently is exactly the thing that
 * makes a reader wonder whether they are two lists.
 *
 * It is the site's ordinary Kit form wearing the redesign's clothes, not a
 * second list: stacking name / email / submit is what a narrow column affords,
 * and the handoff's inline variant is the thing that overflowed its card twice
 * during design. `min-w-0` on the form and its fieldsets plus `box-border` on
 * the inputs is the fix that note asks for — without it a `w-full` input adds
 * its border and padding *outside* the track and pushes the column wider than
 * its container between 900 and 1100px.
 *
 * Labels are `sr-only` rather than hidden: the placeholders carry the visual
 * label, and a hidden `<label>` would take the accessible name with it.
 */
export function WaitlistForm({ actionLabel }: { actionLabel: string }) {
	const router = useRouter()

	return (
		// `@container` on the wrapper, so the form reflows on ITS OWN width rather
		// than the page's. Its two callers give it very different room — ~560px in
		// the /courses hero body, ~420px in the homepage cohort block — and a
		// viewport breakpoint would get one of them wrong at every size.
		<div className="@container w-full min-w-0">
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
					// A grid, not a flex row. Each field arrives wrapped in a
					// `data-sr-fieldset` div carrying `w-full` from the shared
					// component, which in a flex row means every field claims the whole
					// line and `flex-1` cannot beat an explicit width. In a grid
					// `w-full` means "fill my track", which is what was wanted all
					// along — and it needs no `!important` on a component we do not own.
					'grid w-full min-w-0 grid-cols-1 gap-2.5',
					// Name capped, email takes the slack, button sized by its label.
					'@[520px]:grid-cols-[minmax(0,140px)_minmax(0,1fr)_auto] @[520px]:items-start',
					'[&_label]:sr-only',
					'[&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_input]:focus-visible:ring-ring [&_input]:box-border [&_input]:w-full [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm',
					'[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-5 [&_button]:text-sm [&_button]:font-bold [&_button]:shadow-none',
				)}
			/>
		</div>
	)
}
