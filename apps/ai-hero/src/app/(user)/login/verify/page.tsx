import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import {
	MAGIC_LINK_CONFIRMATION_FORM_ACTION,
	MAGIC_LINK_COOKIE_NAME,
	readMagicLinkCookie,
} from '@/server/magic-link-confirmation'

import { Button } from '@coursebuilder/ui/primitives/button'

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
					<>
						<p className="text-muted-foreground mt-4 max-w-md text-lg">
							This login link expired. Request a fresh link to continue.
						</p>
						<Button asChild size="lg" className="mt-8">
							<Link href="/login">Get a new login link</Link>
						</Button>
					</>
				)}
			</main>
		</LayoutClient>
	)
}
