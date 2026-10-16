'use client'

import * as React from 'react'
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
	transferId,
	sendLogin,
}: {
	transferId: string
	sendLogin: (transferId: string) => Promise<{ sent: boolean }>
}) {
	const [state, setState] = React.useState<'idle' | 'pending' | 'sent'>('idle')
	return (
		<button
			type="button"
			disabled={state !== 'idle'}
			onClick={async () => {
				setState('pending')
				// A failed request leaves the button usable.
				await sendLogin(transferId)
					.then((result) => setState(result.sent ? 'sent' : 'idle'))
					.catch(() => setState('idle'))
			}}
			className={BUTTON}
		>
			{state === 'pending'
				? 'Sending…'
				: state === 'sent'
					? 'Check your email'
					: 'Email me a login link'}
		</button>
	)
}
