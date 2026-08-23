import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { createMagicLinkCallbackPath } from '@/server/magic-link-confirmation'

import { Button } from '@coursebuilder/ui/primitives/button'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function VerifyMagicLinkPage({
	searchParams,
}: {
	searchParams: SearchParams
}) {
	const callbackPath = createMagicLinkCallbackPath(await searchParams)

	return (
		<LayoutClient withContainer>
			<main className="flex min-h-[60vh] flex-col items-center justify-center text-center">
				<h1 className="text-4xl font-bold">Confirm your login</h1>
				{callbackPath ? (
					<>
						<p className="text-muted-foreground mt-4 max-w-md text-lg">
							Press continue to use this one-time login link.
						</p>
						<form action={callbackPath} method="post" className="mt-8">
							<Button type="submit" size="lg">
								Continue to AI Hero
							</Button>
						</form>
					</>
				) : (
					<>
						<p className="text-muted-foreground mt-4 max-w-md text-lg">
							This login link is incomplete. Request a fresh link to continue.
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
