'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import { redirectUrlBuilder } from '@/convertkit'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { hasWorkshopInterest } from '@/lib/cta-gating'
import { type Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { CheckCircle } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { WorkshopInterestButton } from './workshop-interest-button'

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
	// A signed-in reader is identified, so this panel must not ask for an email.
	// The server resolves the same way (`resolveEnrolmentIdentity`), so the
	// button it draws and the action it calls agree about who this is.
	const { status: sessionStatus } = useSession()
	const isSignedIn = sessionStatus === 'authenticated'
	const knowsWhoYouAre = Boolean(subscriber) || isSignedIn
	const [done, setDone] = React.useState(false)

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
			router.push(redirectUrlBuilder(sub, '/confirm'))
		}
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
					{/* "Leave your email" is only true when there is a field to leave it
					    in. For a reader we already know, the panel shows one button and
					    the sentence has to stop asking for something it is not asking
					    for. */}
					{knowsWhoYouAre
						? `${workshopTitle ?? 'This workshop'} is on the way. One click and we’ll let you know the moment it’s live.`
						: `${workshopTitle ?? 'This workshop'} is on the way. Leave your email and we’ll let you know the moment it’s live.`}
				</p>
			</div>

			{done ? (
				<p
					className={cn(
						TYPE.meta,
						'text-primary flex items-start gap-2 text-balance',
					)}
				>
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> You&rsquo;re on
					the list. We&rsquo;ll email you the moment it&rsquo;s live.
				</p>
			) : !isResolved || sessionStatus === 'loading' ? (
				<div className="flex flex-col gap-2.5">
					{/* Two fields and a button, so two bars and a button-height bar.
					    The third identical bar was reserving space for a control that
					    never arrives, so the panel visibly resized on every resolve. */}
					<div className="bg-muted h-11 w-full animate-pulse rounded-[9px]" />
					<div className="bg-muted h-11 w-full animate-pulse rounded-[9px]" />
				</div>
			) : knowsWhoYouAre ? (
				<WorkshopInterestButton
					workshopSlug={workshopSlug}
					containerClassName="w-full"
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-[9px] px-[18px] text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
					onSuccess={() => setDone(true)}
				/>
			) : (
				<div>
					<ConversionIntentForm
						intent={{ kind: 'workshop-interest', workshopSlug }}
						surface="workshop-page"
						actionLabel="Notify me"
						onSuccess={handleFormSuccess}
						className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:shadow-none [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-2.5 [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-subtle)] [&_label]:sr-only"
					/>
					{/* `--ah-fg-faint` measured 2.20:1 here. DESIGN rule 7's own
					    callout scopes that step to marks "a reader never has to make
					    out", and a spam-policy promise under a form is text a reader
					    is looking for at the moment they decide whether to type. One
					    step up the ramp, and off 12px mono: it is a sentence. */}
					<p className={cn(TYPE.metaSm, 'mt-3 text-[color:var(--ah-fg-subtle)]')}>
						No spam. Unsubscribe anytime.
					</p>
				</div>
			)}
		</div>
	)
}
