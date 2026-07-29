'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { api } from '@/trpc/react'
import { CheckCircle } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { workshopInterestFieldKey } from './workshop-interest-config'

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
	const { data: subscriber } =
		api.ability.getCurrentSubscriberFromCookie.useQuery()

	const alreadyInterested = workshopSlug
		? Boolean(subscriber?.fields?.[workshopInterestFieldKey(workshopSlug)])
		: false

	if (alreadyInterested) {
		return (
			<p
				className={cn(
					TYPE.meta,
					'text-primary inline-flex items-center gap-2 text-balance',
				)}
			>
				<CheckCircle className="h-4 w-4" /> You&rsquo;re on the list. We&rsquo;ll
				email you the moment it&rsquo;s live.
			</p>
		)
	}

	const handleClick = () => {
		const buy = document.getElementById('buy')
		// On desktop the interest form sits in the sticky sidebar and is already
		// in view, so don't scroll at all — just focus its first field. On mobile
		// the form is below the body, so scroll down to it instead (and don't
		// focus, to avoid popping the keyboard early).
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
