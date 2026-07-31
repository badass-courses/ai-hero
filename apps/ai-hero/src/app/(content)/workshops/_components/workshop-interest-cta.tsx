'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { hasWorkshopInterest } from '@/lib/cta-gating'
import { type Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { CheckCircle } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import {
	addWorkshopInterest,
	tagWorkshopInterestByEmail,
} from './workshop-interest-actions'
import { workshopInterestFieldKey } from './workshop-interest-config'

/**
 * Pre-launch interest capture shown in the workshop sidebar while a workshop is
 * not yet published. New visitors subscribe via the ConvertKit form (carrying a
 * per-workshop custom field); people already on the list get a one-click button.
 *
 * Same panel language as `PrimaryNewsletterCta` and `NewsletterSection` — a
 * bordered card on `--ah-band`, mono eyebrow, `panelTitle` ask, 44px controls
 * at 9px radius, gold submit. It used to wear a permanently animating rainbow
 * frame, which is the resource row's *hover* signature (DESIGN rule 13) spent
 * on a sidebar form that never stops moving.
 */
export const WorkshopInterestCta = ({
	workshopSlug,
	workshopTitle,
	className,
}: {
	workshopSlug: string
	workshopTitle?: string
	className?: string
}) => {
	const router = useRouter()
	const { subscriber, isResolved } = useCtaGate()
	const [isPending, startTransition] = React.useTransition()
	const [done, setDone] = React.useState(false)
	const [error, setError] = React.useState(false)

	const fieldKey = workshopInterestFieldKey(workshopSlug)
	const today = new Date().toISOString().slice(0, 10)

	// They already expressed interest in this specific workshop on a prior visit.
	const alreadyInterested = hasWorkshopInterest(subscriber, workshopSlug)

	// …in which case there is nothing here for them. The card used to stay put
	// and swap its form for "You're on the list", which is a panel-sized way of
	// saying nothing: it asks for no decision, offers no link, and takes the
	// same space in the sidebar on every visit until the workshop ships.
	//
	// `done` is different and deliberately still renders. That is a confirmation
	// of a click made a second ago, and an action that produces no visible
	// result reads as an action that failed.
	if (alreadyInterested && !done) return null

	const handleFormSuccess = (sub?: Subscriber) => {
		if (sub) {
			track('subscribed', {
				location: 'workshop_interest',
				workshop: workshopSlug,
			})
			// The form sets the per-workshop field but can't apply a tag, so tag
			// the new subscriber for parity with the one-click path. Fire-and-forget
			// (best-effort) so the redirect isn't blocked on the Kit round-trips.
			if (sub.email_address) {
				void tagWorkshopInterestByEmail(sub.email_address, workshopSlug).catch(
					() => {},
				)
			}
			router.push(redirectUrlBuilder(sub, '/confirm'))
		}
	}

	const handleKnownSubscriberClick = () => {
		setError(false)
		startTransition(async () => {
			const result = await addWorkshopInterest(workshopSlug)
			if (result.success) {
				track('subscribed', {
					location: 'workshop_interest_existing',
					workshop: workshopSlug,
				})
				setDone(true)
			} else {
				setError(true)
			}
		})
	}

	return (
		<div
			className={cn(
				'border-border flex flex-col gap-4 rounded-lg border bg-[color:var(--ah-band)] px-5 py-6 sm:px-6',
				className,
			)}
		>
			<div className="flex flex-col gap-1.5">
				{/* A status badge, in its own neutral treatment: the yellow belongs to the
				    site's one primary action, and a status wearing it competes. */}
				<p>
					<span className={cn(TYPE.badge, BADGE_NEUTRAL, 'inline-block')}>
						Waitlist open
					</span>
				</p>
				<h3 className={cn(TYPE.panelTitle, 'text-balance font-sans')}>
					Be first in line
				</h3>
				<p
					className={cn(
						TYPE.metaProse,
						'text-pretty text-[color:var(--ah-fg-muted)]',
					)}
				>
					{`${workshopTitle ?? 'This workshop'} is on the way. Leave your email and we’ll let you know the moment it’s live.`}
				</p>
			</div>

			{done ? (
				<p
					className={cn(
						TYPE.meta,
						'text-primary flex items-start gap-2 text-balance',
					)}
				>
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> You&rsquo;re on the
					list. We&rsquo;ll email you the moment it&rsquo;s live.
				</p>
			) : !isResolved ? (
				<div className="flex flex-col gap-2.5">
					<div className="bg-muted h-11 w-full animate-pulse rounded-[9px]" />
					<div className="bg-muted h-11 w-full animate-pulse rounded-[9px]" />
					<div className="bg-muted h-11 w-full animate-pulse rounded-[9px]" />
				</div>
			) : subscriber ? (
				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={handleKnownSubscriberClick}
						disabled={isPending}
						className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-[9px] px-[18px] text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
					>
						{isPending ? 'Adding you…' : 'Keep me posted'}
					</button>
					{error && (
						<p className={cn(TYPE.meta, 'text-destructive')}>
							Something went wrong. Please try again.
						</p>
					)}
				</div>
			) : (
				<div>
					<SubscribeToConvertkitForm
						actionLabel="Notify me"
						fields={{ [fieldKey]: today }}
						onSuccess={handleFormSuccess}
						className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:shadow-none [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-2.5 [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_label]:hidden"
					/>
					<p
						className={cn(TYPE.command, 'mt-3 text-[color:var(--ah-fg-faint)]')}
					>
						No spam. Unsubscribe anytime.
					</p>
				</div>
			)}
		</div>
	)
}
