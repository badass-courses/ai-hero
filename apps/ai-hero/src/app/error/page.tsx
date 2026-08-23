import { headers } from 'next/headers'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { runLogSinkSafely } from '@/server/auth-logger'
import { log } from '@/server/logger'
import { Mail } from 'lucide-react'

import { Button } from '@coursebuilder/ui/primitives/button'

type PublicAuthErrorCode =
	| 'access-denied'
	| 'account-not-linked'
	| 'configuration'
	| 'login-required'
	| 'magic-link-invalid'
	| 'oauth-callback'
	| 'oauth-missing-email'
	| 'oauth-signin'
	| 'unknown'

type PublicSupportCode =
	| 'AH-AUTH-100'
	| 'AH-AUTH-101'
	| 'AH-AUTH-102'
	| 'AH-AUTH-103'
	| 'AH-AUTH-104'
	| 'AH-AUTH-105'
	| 'AH-AUTH-106'
	| 'AH-AUTH-107'
	| 'AH-AUTH-108'

type ErrorInfo = {
	publicCode: PublicAuthErrorCode
	supportCode: PublicSupportCode
	title: string
	message: string
	actions: Array<{
		label: string
		href: string
		variant?: 'default' | 'outline'
	}>
}

type SafeAuthReferer = {
	route: 'auth-error' | 'login' | 'oauth-callback'
	provider: 'discord' | 'github' | 'postmark' | null
	hasCode: boolean
	hasState: boolean
	hasCallbackUrl: boolean
}

export function getSafeAuthReferer(
	referer: string | null,
	expectedBaseUrl: string,
): SafeAuthReferer | null {
	if (!referer) return null

	try {
		const url = new URL(referer)
		const expectedOrigin = new URL(expectedBaseUrl).origin
		if (url.origin !== expectedOrigin) return null

		const callbackMatch = url.pathname.match(
			/^\/api\/auth\/callback\/(discord|github|postmark)$/,
		)
		const route = callbackMatch
			? 'oauth-callback'
			: url.pathname === '/error'
				? 'auth-error'
				: url.pathname === '/login'
					? 'login'
					: null
		if (!route) return null

		const provider = callbackMatch?.[1]
		return {
			route,
			provider:
				provider === 'discord' ||
				provider === 'github' ||
				provider === 'postmark'
					? provider
					: null,
			hasCode: url.searchParams.has('code'),
			hasState: url.searchParams.has('state'),
			hasCallbackUrl: url.searchParams.has('callbackUrl'),
		}
	} catch {
		return null
	}
}

export function buildSupportEmailHref(
	supportEmail: string,
	supportCode: ErrorInfo['supportCode'],
): string {
	const search = new URLSearchParams({
		subject: `AI Hero sign-in help (${supportCode})`,
	})
	return `mailto:${encodeURIComponent(supportEmail)}?${search.toString()}`
}

export function getErrorInfo(error: string | undefined): ErrorInfo {
	switch (error) {
		case 'Verification':
			return {
				publicCode: 'magic-link-invalid',
				supportCode: 'AH-AUTH-101',
				title: 'Login link expired',
				message:
					'That login link is no longer valid. This can happen if it was opened more than once, opened on another device, or the link expired. Request a fresh login link from the same device and browser you want to use.',
				actions: [
					{ label: 'Get a new login link', href: '/login', variant: 'default' },
				],
			}
		case 'OAuthAccountNotLinked':
		case 'AccountNotLinked':
			return {
				publicCode: 'account-not-linked',
				supportCode: 'AH-AUTH-102',
				title: 'Account not connected',
				message:
					'That provider account is not connected to your AI Hero account. Sign in with email first, then connect GitHub or Discord from your profile.',
				actions: [
					{ label: 'Try again', href: '/login', variant: 'default' },
					{ label: 'Go to profile', href: '/profile', variant: 'outline' },
				],
			}
		case 'OAuthCallback':
		case 'OAuthCallbackError':
			return {
				publicCode: 'oauth-callback',
				supportCode: 'AH-AUTH-103',
				title: "Sign-in couldn't be completed",
				message:
					'GitHub or Discord returned to AI Hero without completing sign-in. Try again or choose a different sign-in method.',
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'OAuthProfileMissingEmail':
			return {
				publicCode: 'oauth-missing-email',
				supportCode: 'AH-AUTH-104',
				title: 'Email address required',
				message:
					'Your sign-in provider did not share a verified email address with AI Hero. Add or verify an email with the provider, then try again or choose a different sign-in method.',
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'AccessDenied':
			return {
				publicCode: 'access-denied',
				supportCode: 'AH-AUTH-105',
				title: 'Sign-in was not completed',
				message:
					'AI Hero could not complete this sign-in. Try again or choose a different sign-in method. Contact support if it keeps happening.',
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'Configuration':
			return {
				publicCode: 'configuration',
				supportCode: 'AH-AUTH-106',
				title: "We couldn't complete sign-in",
				message:
					'AI Hero hit a problem while completing sign-in. Try again or choose a different sign-in method. Contact support with the reference below if it keeps happening.',
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'OAuthSignin':
			return {
				publicCode: 'oauth-signin',
				supportCode: 'AH-AUTH-107',
				title: 'Could not start sign-in',
				message:
					"We couldn't redirect you to the sign-in provider. This is usually temporary. Try again or choose a different sign-in method.",
				actions: [{ label: 'Try again', href: '/login', variant: 'default' }],
			}
		case 'SessionRequired':
			return {
				publicCode: 'login-required',
				supportCode: 'AH-AUTH-108',
				title: 'Login required',
				message: 'You need to be logged in to access that page.',
				actions: [{ label: 'Log in', href: '/login', variant: 'default' }],
			}
		default:
			return {
				publicCode: 'unknown',
				supportCode: 'AH-AUTH-100',
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
		runLogSinkSafely(() =>
			log.error('auth.error_page.shown', {
				authErrorCode: info.publicCode,
				supportCode: info.supportCode,
				referer: getSafeAuthReferer(
					headersList.get('referer'),
					env.NEXT_PUBLIC_URL,
				),
			}),
		)
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
							href={buildSupportEmailHref(
								env.NEXT_PUBLIC_SUPPORT_EMAIL,
								info.supportCode,
							)}
							className="flex items-center gap-2"
						>
							<Mail className="h-4 w-4" />
							Contact support
						</Link>
					</Button>
				</div>
				<p className="text-muted-foreground/50 mt-6 text-xs">
					Reference: {info.supportCode}
				</p>
			</div>
		</LayoutClient>
	)
}
