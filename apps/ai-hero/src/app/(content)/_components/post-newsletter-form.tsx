'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { type Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The subscribe control inside a post's "Keep learning" cell
 * (`Skill Article Page.dc.html` § RELATED + NEWSLETTER).
 *
 * Same machinery as `PrimaryNewsletterCta` — `SubscribeToConvertkitForm`, the
 * `subscribed` track call, and the `/confirm` redirect — at the prototype's
 * inline size instead of the centred 64px-control band. Written out here rather
 * than restyled through `PrimaryNewsletterCta`'s className, because that
 * component hardcodes the pill inputs and the centred layout it was drawn for.
 *
 * The prototype's row is one email field; this keeps the first-name field the
 * rest of the site collects, so the row is three cells wide on desktop and
 * stacks below `sm`.
 */
export function PostNewsletterForm({
	trackParams,
}: {
	trackParams?: Record<string, string>
}) {
	const router = useRouter()
	const { data: subscriber } = api.ability.getCurrentSubscriberFromCookie.useQuery()

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (!subscriber) return
		track('subscribed', trackParams)
		router.push(redirectUrlBuilder(subscriber, '/confirm'))
	}

	if (subscriber) {
		return (
			<p
				className={cn(
					TYPE.metaProse,
					'text-[color:var(--ah-fg-muted)]',
				)}
			>
				You're subscribed, thanks. The next one lands in your inbox.
			</p>
		)
	}

	return (
		<div className="w-full max-w-[520px]">
			<SubscribeToConvertkitForm
				actionLabel="Subscribe"
				onSuccess={handleOnSuccess}
				className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-2.5 desk:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto] [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_label]:hidden"
			/>
			<p className={cn(TYPE.command, 'mt-3 text-[color:var(--ah-fg-faint)]')}>
				No spam. Unsubscribe anytime.
			</p>
		</div>
	)
}
