'use client'

import { differentAccountCopy } from '@/lib/purchase-viewer'
import { signOut } from 'next-auth/react'

import { Button } from '@coursebuilder/ui'

/**
 * Shown to a signed-in viewer who does not own the purchase. It carries no
 * purchase details: only the viewer's own masked email, a way out, and the
 * hint that the owner's login link is in their inbox.
 */
export function DifferentAccountNotice({
	viewerEmail,
	signOutCallbackUrl,
}: {
	viewerEmail: string | null | undefined
	signOutCallbackUrl: string
}) {
	const copy = differentAccountCopy(viewerEmail)
	return (
		<section className="px-[18px] py-20 sm:px-11 md:py-24">
			<h1 className="text-3xl font-normal leading-tight tracking-tight sm:text-4xl">
				{copy.title}
			</h1>
			<p className="text-foreground/70 mt-4 max-w-2xl text-lg leading-relaxed">
				{copy.description}
			</p>
			<p className="text-foreground/70 mt-2 max-w-2xl leading-relaxed">
				Check your email for the login link, or sign out and use the account
				that made the purchase.
			</p>
			<Button
				type="button"
				className="mt-6 rounded-none"
				onClick={() => signOut({ callbackUrl: signOutCallbackUrl })}
			>
				Sign out
			</Button>
		</section>
	)
}
