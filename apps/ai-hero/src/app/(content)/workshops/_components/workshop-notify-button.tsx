'use client'

import * as React from 'react'
import { api } from '@/trpc/react'
import { CheckCircle } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { workshopInterestFieldKey } from './workshop-interest-config'

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
			<p className="text-primary inline-flex items-center gap-2 text-balance text-sm font-medium">
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
			className={cn('h-12 cursor-pointer rounded-none px-8', className)}
			onClick={handleClick}
		>
			{children}
		</Button>
	)
}
