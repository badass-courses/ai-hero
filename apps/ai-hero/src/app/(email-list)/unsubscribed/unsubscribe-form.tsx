'use client'

import * as React from 'react'
import Link from 'next/link'

import { unsubscribeAction, type UnsubscribeActionState } from './actions'

/**
 * The confirm step for /unsubscribed. Shows the question until the button is
 * pressed, then the confirmation copy once the server action has written.
 */
export function UnsubscribeForm({
	listName,
	hiddenFields,
	managePreferencesHref,
}: {
	listName: string
	hiddenFields: Record<string, string>
	managePreferencesHref: string
}) {
	const [state, formAction, pending] = React.useActionState<
		UnsubscribeActionState,
		FormData
	>(unsubscribeAction, { status: 'idle' })

	return (
		<>
			<div className="font-heading max-w-xl pt-4 text-3xl">
				{state.status === 'done'
					? `You've been removed from ${listName} and won't receive any more emails.`
					: `Stop ${listName} emails?`}
			</div>
			{state.status !== 'done' && (
				<form action={formAction} className="mt-6">
					{Object.entries(hiddenFields).map(([name, value]) => (
						<input key={name} type="hidden" name={name} value={value} />
					))}
					<button
						type="submit"
						disabled={pending}
						className="bg-primary text-primary-foreground rounded-md px-5 py-2 text-sm font-medium disabled:opacity-50"
					>
						Unsubscribe
					</button>
				</form>
			)}
			<Link
				href={managePreferencesHref}
				className="text-primary mt-6 text-sm font-medium hover:underline"
			>
				Manage all email preferences
			</Link>
		</>
	)
}
