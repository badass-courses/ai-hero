import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { REGIONAL_UPGRADE_REASON } from '@/lib/c5-pricing/products'
import { PURCHASE_BLOCKED } from '@/lib/purchase-block'
import { Mail } from 'lucide-react'

import { Button } from '@coursebuilder/ui/primitives/button'

const COPY = {
	default: {
		title: 'Oops! Something went wrong',
		body: 'We encountered an issue while processing your request.',
	},
	[PURCHASE_BLOCKED]: {
		title: "We can't complete this purchase",
		body: 'Please contact support and we will help you from there.',
	},
	[REGIONAL_UPGRADE_REASON]: {
		title: 'You already have a regional ticket',
		body: 'Contact support and we will upgrade it to full access.',
	},
}

/**
 * Error page shown when there's an issue with the checkout process
 * This could be due to invalid checkout URL or other subscription-related errors
 */
export default async function SubscribeErrorPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
	const { reason } = await searchParams
	const copy =
		reason === PURCHASE_BLOCKED || reason === REGIONAL_UPGRADE_REASON
			? COPY[reason]
			: COPY.default

	return (
		<LayoutClient withContainer>
			<div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
				<h1 className="text-4xl font-bold">{copy.title}</h1>
				<p className="text-muted-foreground mt-4 text-lg">{copy.body}</p>
				<div className="mt-8">
					<Button asChild variant="outline" size="lg">
						<Link
							href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}`}
							className="flex items-center gap-2"
						>
							<Mail className="h-4 w-4" />
							Contact team
						</Link>
					</Button>
				</div>
			</div>
		</LayoutClient>
	)
}
