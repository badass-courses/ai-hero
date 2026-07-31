'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { SKILLS_COURSE_PANEL } from '@/lib/skills-content'
import type { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The free email course ask, as an actual form in the `/skills` hero.
 *
 * It used to be a gold button pointing at `/skills/subscribe`, which is a click
 * spent to arrive at the same two fields. The design return puts the fields in
 * the hero — the whole point of moving the CTA out of the rail was that the ask
 * should be the thing you do, not a door to the thing you do.
 *
 * ## Why this is a grid and not a flex row
 *
 * `SubscribeToConvertkitForm` renders each field inside a
 * `<div data-sr-fieldset className="w-full">`, and that `w-full` is baked into
 * the shared component. In a flex row it means `width: 100%` per fieldset, so
 * the two fields each claim the whole line and the row can never happen —
 * `flex-1` does not win against an explicit width, and fighting it needs an
 * `!important` on a component we do not own.
 *
 * In a grid, `w-full` means "fill my track", which is exactly what is wanted.
 * The tracks do the sizing: a capped name field, an email field that takes the
 * slack, and a button sized by its label. One column below 640px of container.
 *
 * The 640px step is the hero's container, not the viewport — the same rule the
 * layout uses, so the form reflows when its own column gets narrow rather than
 * when the window does.
 *
 * Submitting redirects to `/confirm` like every other Kit form on the site, so
 * `/skills/subscribe` stays the page for people arriving from elsewhere.
 */
export function SkillsCourseForm() {
	const router = useRouter()

	return (
		// Capped, because the single-column state is the real layout. Without the
		// rail the hero is one column of the full shell, and an uncapped form ran
		// edge to edge under copy that stops at its reading measure — the fields
		// read as a band across the page rather than as the end of the block they
		// belong to. 600px lands it near where the text above it ends.
		//
		// Above 1080px the grid track already bounds it, so the cap costs nothing
		// there and one value covers both states.
		<div className="max-w-[600px]">
			<SubscribeToConvertkitForm
				id="skills-course-hero"
				actionLabel={SKILLS_COURSE_PANEL.ctaLabel}
				onSuccess={(subscriber) => {
					if (!subscriber) return
					track('skills_course_subscribed', { location: 'skills-hero' })
					router.push(redirectUrlBuilder(subscriber as Subscriber, '/confirm'))
				}}
				className={cn(
					TYPE.meta,
					'grid w-full min-w-0 grid-cols-1 gap-2.5',
					// The name field is capped and the email field takes the slack: an
					// email address is the one that must not be cramped, and a first
					// name fits in far less. The button track is sized by its label.
					'@[640px]:grid-cols-[minmax(0,150px)_minmax(0,1fr)_auto] @[640px]:items-start',
					'[&_label]:sr-only',
					'[&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_input]:focus-visible:ring-ring [&_input]:box-border [&_input]:w-full [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm',
					// Full width in the stacked layout, label-sized once it has its own
					// track. `h-12`/`desk:h-11` on the inputs and `h-[50px]`/`desk:h-11`
					// on the button come from the shared component, so the row lines up
					// on its own above 900px and the button stays the taller thumb
					// target below it (DESIGN rule 19).
					'[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-5 [&_button]:text-sm [&_button]:font-bold [&_button]:shadow-none',
				)}
			/>
			{/* Right-aligned where the row is a row, so it hangs off the button it
			    qualifies rather than off the first field. Sans, not mono. `metaMark` is for data a reader scans — durations,
			    counts, dates — and this is a sentence. It sits a step quieter than
			    the CTA's own description, which is the voice it belongs to. */}
			<p
				className={cn(
					TYPE.metaSm,
					'mt-2.5 text-[color:var(--ah-fg-subtle)] @[640px]:text-right',
				)}
			>
				{SKILLS_COURSE_PANEL.note}
			</p>
		</div>
	)
}
