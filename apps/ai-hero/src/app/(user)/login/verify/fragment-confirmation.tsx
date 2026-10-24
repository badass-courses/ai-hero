'use client'

import * as React from 'react'
import Link from 'next/link'
import {
	consumeMagicLinkFragment,
	type MagicLinkFragment,
} from '@/server/magic-link-fragment'

import { Button } from '@coursebuilder/ui/primitives/button'

/**
 * Confirm UI for the fragment login link (`/login/verify#token=...`). The
 * fragment is read once and removed from the address bar at once; confirming
 * posts the fields in the body, never in a URL.
 */
export function FragmentConfirmation({ action }: { action: string }) {
	const [state, setState] = React.useState<
		MagicLinkFragment | 'pending' | 'expired'
	>('pending')

	React.useEffect(() => {
		setState(consumeMagicLinkFragment(window) ?? 'expired')
	}, [])

	if (state === 'pending') {
		return (
			<p className="text-muted-foreground mt-4 max-w-md text-lg">
				Checking your login link…
			</p>
		)
	}

	if (state === 'expired') {
		return (
			<>
				<p className="text-muted-foreground mt-4 max-w-md text-lg">
					This login link expired. Request a fresh link to continue.
				</p>
				<Button asChild size="lg" className="mt-8">
					<Link href="/login">Get a new login link</Link>
				</Button>
			</>
		)
	}

	return (
		<>
			<p className="text-muted-foreground mt-4 max-w-md text-lg">
				Press continue to use this one-time login link.
			</p>
			<form action={action} method="post" className="mt-8">
				<input type="hidden" name="token" value={state.token} />
				<input type="hidden" name="email" value={state.email} />
				{state.callbackUrl ? (
					<input type="hidden" name="callbackUrl" value={state.callbackUrl} />
				) : null}
				<Button type="submit" size="lg">
					Continue to AI Hero
				</Button>
			</form>
		</>
	)
}
