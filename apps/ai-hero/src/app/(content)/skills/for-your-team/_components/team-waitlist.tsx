'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { TYPE } from '@/components/landing/type'
import { redirectUrlBuilder } from '@/convertkit'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { hasWorkshopInterest } from '@/lib/cta-gating'
import { type Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { CheckCircle } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { WorkshopInterestButton } from '../../../workshops/_components/workshop-interest-button'

/**
 * The crash-course waitlist ask, with no chrome of its own.
 *
 * ## Why this is not `WorkshopInterestCta`
 *
 * That component is a self-contained panel: its own border, its own surface,
 * its own status badge and its own `h3`. That is exactly right in a workshop
 * sidebar, where it has to hold itself together against a column of unrelated
 * material. Dropped into a closing band it was wrong twice over.
 *
 * First, **a bordered box inside a section reads as an advertisement**, and
 * readers skip advertisements. The page spends its whole length earning the
 * right to ask, and then fenced the ask off behind the visual grammar of a
 * thing to ignore.
 *
 * Second, **it brought a second title**. "Keep learning together" and "Be
 * first in line" competed to be the heading of the same block, so the section
 * appeared to be two sections, neither of which owned the ask.
 *
 * So this shares the *behaviour* and none of the presentation: same intent,
 * same surface, same Kit field and tag, same three states, same one-click path
 * for identified readers. The section's own heading is the only heading, and
 * the fields sit directly on the band. Nothing is boxed.
 */
export function TeamWaitlist({
	workshopSlug,
	surface,
	prompt,
	className,
}: {
	className?: string
	workshopSlug: string
	surface: 'skills-for-your-team'
	/**
	 * An optional sentence directly above the fields.
	 *
	 * Usually omitted. The band's own body paragraph does this job, and two
	 * stacked paragraphs — one arguing, one asking — made the close read as two
	 * blocks with a form stuck to the end. One paragraph that ends in the ask,
	 * with the fields immediately under it, reads as a single sentence the
	 * reader finishes by typing.
	 */
	prompt?: string
}) {
	const router = useRouter()
	const { subscriber, isResolved } = useCtaGate()
	const { status: sessionStatus } = useSession()
	const isSignedIn = sessionStatus === 'authenticated'
	const knowsWhoYouAre = Boolean(subscriber) || isSignedIn
	const [done, setDone] = React.useState(false)

	const alreadyInterested = hasWorkshopInterest(subscriber, workshopSlug)

	const handleFormSuccess = (sub?: Subscriber) => {
		if (!sub) return
		track('subscribed', {
			location: 'skills_for_your_team',
			workshop: workshopSlug,
		})
		router.push(redirectUrlBuilder(sub, '/confirm'))
	}

	// Already on this waitlist, and not from a click a second ago. The sidebar
	// version returns null here, which is right in a sidebar and wrong at the
	// end of a page: it would leave the band's heading and argument standing
	// with nothing after them. Confirming is the honest close.
	if (alreadyInterested && !done) {
		return (
			<p
				className={cn(
					TYPE.lead,
					'text-primary flex items-center justify-center gap-2.5 text-balance',
				)}
			>
				<CheckCircle className="h-5 w-5 shrink-0" aria-hidden />
				<span>You&rsquo;re on the list. I&rsquo;ll email you the day it opens.</span>
			</p>
		)
	}

	if (done) {
		return (
			<p
				className={cn(
					TYPE.lead,
					'text-primary flex items-center justify-center gap-2.5 text-balance',
				)}
			>
				<CheckCircle className="h-5 w-5 shrink-0" aria-hidden />
				<span>You&rsquo;re on the list. I&rsquo;ll email you the day it opens.</span>
			</p>
		)
	}

	return (
		<div className={cn('flex w-full flex-col items-center gap-3', className)}>
			{prompt && (
				<p
					className={cn(
						TYPE.body,
						'text-foreground/80 mx-auto max-w-[52ch] text-pretty',
					)}
				>
					{prompt}
				</p>
			)}

			{!isResolved || sessionStatus === 'loading' ? (
				// The resting form's exact geometry: three 48px controls at `gap-2`
				// inside the same `max-w-[380px]` measure. The reassurance line is
				// NOT a skeleton bar — it is the real sentence, rendered now,
				// because it is static text that is true in every state. Faking it
				// with a grey bar would have reserved the wrong height (a 13px line
				// is not a 48px control) and then swapped a placeholder for
				// identical words, which is a flicker with no purpose.
				<div className="flex w-full flex-col items-center gap-3">
					<div
						className="mx-auto flex w-full max-w-[380px] flex-col gap-2"
						aria-busy
					>
						<div className="bg-foreground/[0.06] h-12 w-full animate-pulse rounded-[9px]" />
						<div className="bg-foreground/[0.06] h-12 w-full animate-pulse rounded-[9px]" />
						<div className="bg-foreground/[0.06] h-12 w-full animate-pulse rounded-[9px]" />
					</div>
					<Reassurance />
				</div>
			) : knowsWhoYouAre ? (
				<WorkshopInterestButton
					workshopSlug={workshopSlug}
					surface={surface}
					containerClassName="w-fit"
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-12 cursor-pointer items-center justify-center rounded-[9px] px-7 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
					onSuccess={() => setDone(true)}
				>
					Send me the launch email
				</WorkshopInterestButton>
			) : (
				<>
					<ConversionIntentForm
						intent={{ kind: 'workshop-interest', workshopSlug }}
						surface={surface}
						actionLabel="Send me the launch email"
						onSuccess={handleFormSuccess}
						// Labels stay in the accessibility tree (`sr-only`, never
						// `hidden`): placeholders are not accessible names, and they
						// vanish the moment anyone starts typing.
						className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:focus-visible:ring-ring [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground mx-auto grid w-full max-w-[380px] grid-cols-1 gap-2 [&_button]:h-12 [&_button]:w-full [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-7 [&_button]:text-sm [&_button]:font-bold [&_button]:shadow-none [&_button]:transition [&_input]:h-12 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-subtle)] [&_label]:sr-only"
					/>
					<Reassurance />
				</>
			)}
		</div>
	)
}

/**
 * The one line that is true in every state of this block, so it renders in
 * every state of this block.
 *
 * It used to live only inside the form branch, which meant the loading
 * skeleton reserved height for three controls and none for this sentence: when
 * identity resolved, a line of text appeared and pushed the footer down. The
 * skeleton's whole job is to be the same shape as what replaces it.
 */
function Reassurance() {
	return (
		<p className={cn(TYPE.metaSm, 'text-[color:var(--ah-fg-subtle)]')}>
			No spam. Unsubscribe anytime.
		</p>
	)
}
