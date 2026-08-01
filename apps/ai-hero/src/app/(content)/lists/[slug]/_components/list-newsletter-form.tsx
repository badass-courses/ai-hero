'use client'

import * as React from 'react'
import { ConversionIntentButton } from '@/components/cta/conversion-intent-button'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { TYPE } from '@/components/landing/type'
import { CheckCircle } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The newsletter half of the overview's two-up footer.
 *
 * `SlimNewsletterForm` is the landing's version of this and puts both fields
 * and the button on one line — which needs the full container width. Here the
 * form lives in half of a two-column footer, where that same row squeezes the
 * inputs down to a few characters each. Same fields, same styling vocabulary,
 * wrapped to two lines.
 *
 * A reader the server already knows gets ONE BUTTON instead of the email row:
 * their address came off their cookie or their sign-in, and asking a known
 * person to retype it is the bug `resolveEnrolmentIdentity` exists to close.
 * The form remains the fallback for strangers and for stale identities the
 * server action cannot resolve after all.
 */
export function ListNewsletterForm({
	knownIdentity = false,
}: {
	/** Server-resolved: offer one click instead of an email form. */
	knownIdentity?: boolean
}) {
	const [oneClickResult, setOneClickResult] = React.useState<
		'joined' | 'confirmation-required' | null
	>(null)
	const [requiresIdentityForm, setRequiresIdentityForm] = React.useState(false)

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
		<div className="flex w-full max-w-[460px] flex-col gap-3">
			{knownIdentity && !requiresIdentityForm ? (
				<ConversionIntentButton
					intent={{ kind: 'newsletter' }}
					surface="list-closing"
					label="Subscribe"
					className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex h-[50px] w-full cursor-pointer items-center justify-center rounded-[9px] text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 desk:h-11"
					onSuccess={({ confirmationRequired }) => {
						setOneClickResult(
							confirmationRequired ? 'confirmation-required' : 'joined',
						)
					}}
					onNotIdentified={() => setRequiresIdentityForm(true)}
				/>
			) : (
				<ConversionIntentForm
					intent={{ kind: 'newsletter' }}
					surface="list-closing"
					actionLabel="Subscribe"
					className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-3 desk:grid-cols-2 [&_button]:col-span-full [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-4 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_label]:hidden"
				/>
			)}
			<p className={cn(TYPE.command, 'text-[color:var(--ah-fg-faint)]')}>
				No spam. Unsubscribe anytime.
			</p>
		</div>
	)
}
