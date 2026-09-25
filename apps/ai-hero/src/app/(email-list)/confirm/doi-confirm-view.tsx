import type { ReactNode } from 'react'
import LayoutClient from '@/components/layout-client'
import type { ConfirmPageView } from '@/lib/subscriber-marketing/drovr-confirm-page'

const SUBMIT_PATH = '/confirm/submit'

/**
 * The double opt-in confirm page (`/confirm?t=<token>`, drovr's confirm
 * link). Rendering it confirms nothing: the Confirm button's POST does.
 */
export function DoiConfirmView({
	view,
	token,
}: {
	view: ConfirmPageView
	token: string
}) {
	return (
		<LayoutClient withContainer>
			<main
				className="container mx-auto flex min-h-(--pane-layout-height) w-full max-w-2xl grow flex-col justify-center gap-6 px-5 py-24"
				data-doi-confirm={view.kind}
			>
				{content(view, token)}
			</main>
		</LayoutClient>
	)
}

function content(view: ConfirmPageView, token: string): ReactNode {
	switch (view.kind) {
		case 'awaiting':
			return (
				<>
					<Heading>Confirm your subscription</Heading>
					<p className="text-lg leading-relaxed">
						Press the button to confirm your email address and start the AI Hero
						Skills course.
					</p>
					<SubmitButton token={token} action="confirm" label="Confirm" />
				</>
			)
		case 'confirmed':
			return view.justConfirmed ? (
				<>
					<Heading>You&apos;re in</Heading>
					<p className="text-lg leading-relaxed">
						Your first lesson is on its way. It usually arrives within a few
						minutes.
					</p>
				</>
			) : (
				<>
					<Heading>You&apos;re already confirmed</Heading>
					<p className="text-lg leading-relaxed">
						There&apos;s nothing else to do. Your lessons arrive by email.
					</p>
				</>
			)
		case 'expired':
			return view.resent ? (
				<>
					<Heading>Check your inbox</Heading>
					<p className="text-lg leading-relaxed">
						If you&apos;re eligible, a new confirmation email is on its way.
					</p>
				</>
			) : (
				<>
					<Heading>This link has expired</Heading>
					<p className="text-lg leading-relaxed">
						Confirmation links only last a while. We can send you a new one.
					</p>
					<SubmitButton
						token={token}
						action="resend"
						label="Send me a new link"
					/>
				</>
			)
		case 'suppressed':
			return (
				<>
					<Heading>We can&apos;t subscribe this address</Heading>
					<p className="text-lg leading-relaxed">
						If you think this is a mistake, reply to any AI Hero email or
						contact support.
					</p>
				</>
			)
		case 'unavailable':
			return (
				<>
					<Heading>We can&apos;t confirm right now</Heading>
					<p className="text-lg leading-relaxed">
						Please try again in a moment.
					</p>
					{view.canRetry ? (
						<SubmitButton token={token} action="confirm" label="Try again" />
					) : null}
				</>
			)
		case 'invalid':
			return (
				<>
					<Heading>This link isn&apos;t valid</Heading>
					<p className="text-lg leading-relaxed">
						Use the confirmation link from your email, exactly as it was sent.
					</p>
				</>
			)
	}
}

function Heading({ children }: { children: ReactNode }) {
	return (
		<h1 className="font-heading text-balance text-3xl font-extrabold sm:text-5xl">
			{children}
		</h1>
	)
}

function SubmitButton({
	token,
	action,
	label,
}: {
	token: string
	action: 'confirm' | 'resend'
	label: string
}) {
	return (
		<form action={SUBMIT_PATH} method="post">
			<input name="t" type="hidden" value={token} />
			<input name="action" type="hidden" value={action} />
			<button
				className="bg-primary text-primary-foreground inline-flex min-h-11 items-center justify-center px-6 py-2 font-medium"
				type="submit"
			>
				{label}
			</button>
		</form>
	)
}
