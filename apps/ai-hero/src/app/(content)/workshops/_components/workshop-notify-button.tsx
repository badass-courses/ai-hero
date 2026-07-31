'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { hasWorkshopInterest } from '@/lib/cta-gating'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { WorkshopInterestButton } from './workshop-interest-button'

/**
 * The house primary button (`aihero.css` § `.ah-btn--primary`): 46px tall, 9px
 * radius, 15px bold label.
 *
 * The fill is `bg-accent-fill`, not `bg-primary`. `--primary` is the *text-safe*
 * accent and resolves to ink in light mode (DESIGN rule 7), so the shared
 * `Button`'s default variant paints this CTA black on paper and gold at night.
 * `--accent-fill` is the gold that survives both themes.
 */
export const WORKSHOP_CTA_BUTTON =
	'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover h-[46px] cursor-pointer rounded-[9px] px-5 text-[15px] font-bold'

/**
 * In-body CTA for pre-launch workshops: scrolls to the sidebar interest-capture
 * form (the single source of signups) rather than showing a buy button. If the
 * current subscriber already expressed interest in this workshop, shows the
 * confirmed state instead.
 */
export const WorkshopNotifyButton = ({
	workshopSlug,
	className,
	children = 'Get notified',
}: {
	workshopSlug?: string
	className?: string
	children?: React.ReactNode
}) => {
	const { subscriber } = useCtaGate()
	const { status: sessionStatus } = useSession()
	const [done, setDone] = React.useState(false)
	const knowsWhoYouAre = Boolean(subscriber) || sessionStatus === 'authenticated'

	// Already on this workshop's list, so there is nothing to press. This used
	// to render a line of confirmation copy in the button's place — mid-body,
	// where the reader is looking for what to do next and finds a sentence
	// telling them about a decision they already made. The sidebar's capture
	// card hides itself for the same reader; this is the in-body half of that.
	if (hasWorkshopInterest(subscriber, workshopSlug)) {
		return null
	}

	if (done) {
		return <p className="text-primary text-sm font-medium">You&rsquo;re on the list.</p>
	}

	if (knowsWhoYouAre && workshopSlug) {
		return (
			<WorkshopInterestButton
				workshopSlug={workshopSlug}
				className={cn(WORKSHOP_CTA_BUTTON, className)}
				onSuccess={() => setDone(true)}
			>
				{children}
			</WorkshopInterestButton>
		)
	}

	const handleClick = () => {
		const buy = document.getElementById('buy')
		// Anonymous readers still need the sidebar form. On desktop it is already
		// in view, so focus its first field; on mobile scroll down without opening
		// the keyboard early. Identified readers never take this path: their CTA
		// performs the same one-click action as the sidebar button above.
		if (window.matchMedia('(min-width: 768px)').matches) {
			buy
				?.querySelector<HTMLInputElement>('input')
				?.focus({ preventScroll: true })
		} else {
			buy?.scrollIntoView({ behavior: 'smooth', block: 'start' })
		}
	}

	return (
		<Button
			size="lg"
			className={cn(WORKSHOP_CTA_BUTTON, className)}
			onClick={handleClick}
		>
			{children}
		</Button>
	)
}
