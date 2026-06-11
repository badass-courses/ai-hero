import { headers } from 'next/headers'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { Mail } from 'lucide-react'

import { Button } from '@coursebuilder/ui/primitives/button'

type ErrorInfo = {
	title: string
	message: string
	actions: Array<{
		label: string
		href: string
		variant?: 'default' | 'outline'
	}>
}

export function getErrorInfo(error: string | undefined): ErrorInfo {
	switch (error) {
		case 'Verification':
			return {
				title: 'Login link expired',
				message:
					'That login link is no longer valid. This can happen if it was opened more than once, opened on another device, or the link expired. Request a fresh login link from the same device and browser you want to use.',
				actions: [
					{ label: 'Get a new login link', href: '/login', variant: 'default' },
				],
			}
		case 'OAuthAccountNotLinked':
			return {
				title: 'Account linking failed',
				message:
					"Your OAuth provider email doesn't match the email on your existing account, so we couldn't connect the accounts automatically. Log in with your original method first, then try connecting the provider again from your profile.",
				actions: [
					{ label: 'Log in', href: '/login', variant: 'default' },
					{ label: 'Go to profile', href: '/profile', variant: 'outline' },
				],
			}
		case 'OAuthCallback':
			return {
				title: 'Sign-in interrupted',
				message:
					'Something went wrong during the OAuth callback. This can happen if the page was refreshed or the session expired mid-flow. Please try again.',
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'OAuthSignin':
			return {
				title: 'Could not start sign-in',
				message:
					"We couldn't redirect you to the sign-in provider. This is usually temporary, please try again.",
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'SessionRequired':
			return {
				title: 'Login required',
				message: 'You need to be logged in to access that page.',
				actions: [{ label: 'Log in', href: '/login', variant: 'default' }],
			}
		default:
			return {
				title: 'Something went wrong',
				message:
					'We encountered an unexpected issue. Please try again or contact support if this persists.',
				actions: [{ label: 'Go to login', href: '/login', variant: 'default' }],
			}
	}
}

export default async function AuthErrorPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>
}) {
	const { error } = await searchParams
	const info = getErrorInfo(error)

	if (error) {
		const headersList = await headers()
		void log.error('auth.error_page.shown', {
			errorCode: error,
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
							href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}?subject=Auth error: ${error || 'unknown'}`}
							className="flex items-center gap-2"
						>
							<Mail className="h-4 w-4" />
							Contact support
						</Link>
					</Button>
				</div>
				{error && (
					<p className="text-muted-foreground/50 mt-6 text-xs">
						Error code: {error}
					</p>
				)}
			</div>
		</LayoutClient>
	)
}
