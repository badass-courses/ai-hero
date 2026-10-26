import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { REGIONAL_UPGRADE_REASON } from '@/lib/c5-pricing/products'
import { PURCHASE_BLOCKED } from '@/lib/purchase-block'
import {
	CHECKOUT_LINK_EXPIRED,
	CHECKOUT_UNAVAILABLE,
	INVALID_QUANTITY,
	REGIONAL_TEAM_NOT_ALLOWED,
} from '@/lib/purchase-guardrails'
import { Mail } from 'lucide-react'

import { Button } from '@coursebuilder/ui/primitives/button'

const COPY = {
	default: {
		title: 'This link may have expired',
		body: 'Links stop working after a while. Ask for a new one and we will email it to you.',
	},
	[PURCHASE_BLOCKED]: {
		title: "We can't complete this purchase",
		body: 'Please contact support and we will help you from there.',
	},
	[REGIONAL_TEAM_NOT_ALLOWED]: {
		title: 'Regional pricing is for one seat',
		body: 'Team seats are sold at the normal team price. Remove the regional discount and start your team checkout again.',
	},
	[REGIONAL_UPGRADE_REASON]: {
		title: 'You already have a regional ticket',
		body: 'Contact support and we will upgrade it to full access.',
	},
	// The emailed sign-in link opened in a different browser (often a mail
	// app's built-in browser) from the one that started checkout.
	'browser-mismatch': {
		title: "You're signed in. One more step",
		body: "The sign-in link opened in a different browser from the one you started in. You're signed in here now, so go back to the course page in this browser and click Enroll again.",
	},
	[CHECKOUT_LINK_EXPIRED]: {
		title: 'This checkout link has expired',
		body: 'Go back to the course page and click Enroll again to start a fresh checkout.',
	},
	[INVALID_QUANTITY]: {
		title: "That number of seats doesn't work",
		body: 'Go back to the course page and choose your seats again.',
	},
	[CHECKOUT_UNAVAILABLE]: {
		title: "We couldn't start checkout",
		body: 'The problem is on our side. Try again in a few minutes, or contact the team.',
	},
} as const

type CopyReason = keyof typeof COPY

function isCopyReason(reason: unknown): reason is CopyReason {
	return (
		typeof reason === 'string' && reason !== 'default' && Object.hasOwn(COPY, reason)
	)
}

/**
 * Error page shown when there's an issue with the checkout process
 * This could be due to invalid checkout URL or other subscription-related errors
 */
export default async function SubscribeErrorPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
	const { reason } = await searchParams
	const known = isCopyReason(reason)
	const copy = known ? COPY[reason] : COPY.default

	return (
		<LayoutClient withContainer>
			<div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
				<h1 className="text-4xl font-bold">{copy.title}</h1>
				<p className="text-muted-foreground mt-4 text-lg">{copy.body}</p>
				<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
					{!known && (
						<Button asChild size="lg">
							<Link href="/login">Send me a new link</Link>
						</Button>
					)}
					<Button asChild variant="outline" size="lg">
						<Link
							href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}`}
							className="flex items-center gap-2"
						>
							<Mail className="h-4 w-4" />
							Contact team
						</Link>
					</Button>
				</div>
			</div>
		</LayoutClient>
	)
}
