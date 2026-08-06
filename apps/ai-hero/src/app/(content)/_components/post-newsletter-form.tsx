'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ConversionIntentButton } from '@/components/cta/conversion-intent-button'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { TYPE } from '@/components/landing/type'
import { signupConfirmationUrlBuilder } from '@/convertkit'
import { type Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { CheckCircle } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The subscribe control inside a post's "Keep learning" cell
 * (`Skill Article Page.dc.html` § RELATED + NEWSLETTER).
 *
 * Same machinery as `PrimaryNewsletterCta` — the intent-aware form, the
 * `subscribed` track call, and the `/confirm` redirect — at the prototype's
 * inline size instead of the centred 64px-control band. Written out here rather
 * than restyled through `PrimaryNewsletterCta`'s className, because that
 * component hardcodes the pill inputs and the centred layout it was drawn for.
 *
 * A reader the server already knows gets ONE BUTTON. Their address came off
 * their cookie or their sign-in, so a name-and-email row would ask a known
 * person to retype something the server is holding — the exact bug
 * `resolveEnrolmentIdentity` exists to close. The form remains the fallback,
 * both for strangers and for the rare stale identity the server action cannot
 * resolve after all.
 *
 * It does NOT check for an existing subscriber, on purpose. Whether the ask
 * appears at all is decided one level up by `PostRelatedNewsletter`, on the
 * server, because that decision changes the closing GRID — a subscriber gets
 * related reading across the full row rather than a half-width cell holding a
 * form. This component used to make the call itself and could only swap the
 * form for "You're subscribed, thanks.", which left the cell, its heading and
 * its "Join 98,000+ developers" promise sitting there with nothing to accept.
 */
export function PostNewsletterForm({
	trackParams,
	knownIdentity = false,
}: {
	trackParams?: Record<string, string>
	/** Server-resolved: offer one click instead of an email form. */
	knownIdentity?: boolean
}) {
	const router = useRouter()
	const [oneClickResult, setOneClickResult] = React.useState<
		'joined' | 'confirmation-required' | null
	>(null)
	const [requiresIdentityForm, setRequiresIdentityForm] = React.useState(false)

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (!subscriber) return
		track('subscribed', trackParams)
		router.push(signupConfirmationUrlBuilder(subscriber, 'email-confirmation'))
	}

	if (oneClickResult) {
		return (
			<p
				className={cn(
					TYPE.metaProse,
					'inline-flex items-center gap-2 text-[color:var(--ah-fg-muted)]',
				)}
			>
				<CheckCircle aria-hidden className="text-primary size-4 flex-none" />
				{oneClickResult === 'joined'
					? 'You’re on the list.'
					: 'Check your inbox to confirm.'}
			</p>
		)
	}

	return (
		<div className="w-full max-w-[520px]">
			{knownIdentity && !requiresIdentityForm ? (
				<ConversionIntentButton
					intent={{ kind: 'newsletter' }}
					surface="post-closing"
					label="Subscribe"
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex h-[50px] w-full cursor-pointer items-center justify-center rounded-[9px] px-[18px] text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 desk:h-11 desk:w-auto desk:min-w-40"
					onSuccess={({ confirmationRequired }) => {
						track('subscribed', { ...trackParams, method: 'one-click' })
						setOneClickResult(
							confirmationRequired ? 'confirmation-required' : 'joined',
						)
					}}
					onNotIdentified={() => setRequiresIdentityForm(true)}
				/>
			) : (
				<ConversionIntentForm
					intent={{ kind: 'newsletter' }}
					surface="post-closing"
					actionLabel="Subscribe"
					onSuccess={handleOnSuccess}
					className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-2.5 desk:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto] [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_label]:hidden"
				/>
			)}
			<p className={cn(TYPE.command, 'mt-3 text-[color:var(--ah-fg-faint)]')}>
				No spam. Unsubscribe anytime.
			</p>
		</div>
	)
}
