'use client'

import * as React from 'react'
import { signIn } from 'next-auth/react'
import { useFormStatus } from 'react-dom'

import { cn } from '@coursebuilder/ui/utils/cn'

import { PURCHASE_PRIMARY_BUTTON } from '../../../_components/post-purchase-parts'

const BUTTON = cn(
	PURCHASE_PRIMARY_BUTTON,
	'disabled:pointer-events-none disabled:opacity-70',
)

/** Submits the accept form, and says so while the transfer completes. */
export function TransferAcceptButton() {
	const { pending } = useFormStatus()
	return (
		<button
			type="submit"
			disabled={pending}
			className={BUTTON}
		>
			{pending ? 'Accepting…' : 'Accept transfer'}
		</button>
	)
}

/**
 * Emails a login link for the recipient's address that comes back here. The
 * invitation's own link works once; this is the way back after that.
 */
export function TransferLoginButton({
	email,
	callbackUrl,
}: {
	email: string
	callbackUrl: string
}) {
	const [pending, setPending] = React.useState(false)
	return (
		<button
			type="button"
			disabled={pending}
			onClick={async () => {
				setPending(true)
				// Success navigates away; a failed request leaves the button usable.
				await signIn('postmark', { email, callbackUrl }).catch(() =>
					setPending(false),
				)
			}}
			className={BUTTON}
		>
			{pending ? 'Sending…' : 'Email me a login link'}
		</button>
	)
}
