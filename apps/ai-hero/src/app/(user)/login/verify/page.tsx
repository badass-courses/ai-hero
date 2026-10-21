import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import {
	MAGIC_LINK_CONFIRMATION_FORM_ACTION,
	MAGIC_LINK_COOKIE_NAME,
	readMagicLinkCookie,
} from '@/server/magic-link-confirmation'

import { Button } from '@coursebuilder/ui/primitives/button'

import { FragmentConfirmation } from './fragment-confirmation'

export const dynamic = 'force-dynamic'
export const metadata = {
	referrer: 'no-referrer',
	robots: { index: false, follow: false },
} satisfies Metadata

export default async function VerifyMagicLinkPage() {
	const cookieStore = await cookies()
	const confirmation = readMagicLinkCookie(
		cookieStore.get(MAGIC_LINK_COOKIE_NAME)?.value,
		env.NEXTAUTH_SECRET ?? '',
	)

	return (
		<LayoutClient withContainer>
			<main className="flex min-h-[60vh] flex-col items-center justify-center text-center">
				<h1 className="text-4xl font-bold">Confirm your login</h1>
				{confirmation ? (
					<>
						<p className="text-muted-foreground mt-4 max-w-md text-lg">
							Press continue to use this one-time login link.
						</p>
						<form
							action={MAGIC_LINK_CONFIRMATION_FORM_ACTION}
							method="post"
							className="mt-8"
						>
							<Button type="submit" size="lg">
								Continue to AI Hero
							</Button>
						</form>
					</>
				) : (
					// No cookie: either the fragment link (read in the browser, the
					// server never sees it) or an expired one.
					<FragmentConfirmation action={MAGIC_LINK_CONFIRMATION_FORM_ACTION} />
				)}
			</main>
		</LayoutClient>
	)
}
