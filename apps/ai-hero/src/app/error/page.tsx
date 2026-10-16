import { headers } from 'next/headers'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { Login } from '@/components/login'
import { env } from '@/env.mjs'
import { authErrorView, knownAuthErrorCode } from '@/lib/auth-error-view'
import { getProviders } from '@/server/auth'
import { log } from '@/server/logger'
import { Mail } from 'lucide-react'

import { Button } from '@coursebuilder/ui/primitives/button'

function emailOnly(providers: ReturnType<typeof getProviders>) {
	return providers?.postmark ? { postmark: providers.postmark } : providers
}

export default async function AuthErrorPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>
}) {
	const { error } = await searchParams
	const info = authErrorView(error)
	const code = knownAuthErrorCode(error)

	if (error) {
		const headersList = await headers()
		void log.error('auth.error_page.shown', {
			errorCode: code ?? 'unrecognized',
			errorTitle: info.title,
			referer: headersList.get('referer'),
			userAgent: headersList.get('user-agent'),
			country: headersList.get('x-vercel-ip-country'),
			region: headersList.get('x-vercel-ip-country-region'),
			city: headersList.get('x-vercel-ip-city'),
			requestId: headersList.get('x-vercel-id'),
			forwardedHost: headersList.get('x-forwarded-host'),
		})
	}

	return (
		<LayoutClient withContainer>
			<div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
				<h1 className="text-4xl font-bold">{info.title}</h1>
				<p className="text-muted-foreground mt-4 max-w-md text-lg">
					{info.message}
				</p>
				{info.emailForm ? (
					<Login
						className="!min-h-0 py-8"
						// Email only: this page is for recovering a login link, not for
						// offering GitHub or Discord ahead of the form.
						providers={emailOnly(getProviders())}
						title="Get a new login link"
					/>
				) : null}
				<div className="mt-8 flex flex-wrap justify-center gap-3">
					{info.actions.map((action) => (
						<Button
							key={action.href}
							asChild
							variant={action.variant ?? 'default'}
							size="lg"
						>
							<Link href={action.href}>{action.label}</Link>
						</Button>
					))}
					<Button asChild variant="outline" size="lg">
						<Link
							href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}?subject=Auth error: ${code ?? 'unknown'}`}
							className="flex items-center gap-2"
						>
							<Mail className="h-4 w-4" />
							Contact support
						</Link>
					</Button>
				</div>
			</div>
		</LayoutClient>
	)
}
