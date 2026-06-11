import { NextResponse } from 'next/server'

import {
	AI_CODING_COHORT_SLUG,
	getCampaignLanding,
} from './lib/campaign-landings'
import { auth } from './server/auth'
import { log } from './server/logger'
import {
	determineOrgAccess,
	type OrganizationRole,
} from './utils/determine-org-access'

type Role = {
	id: string
	organizationId: string | null
	name: string
	description: string | null
	active: boolean
	createdAt: string
	updatedAt: string
	deletedAt: string | null
}

type ReqUser = {
	id: string
	name: string
	role: string
	email: string
	fields: Record<string, any>
	emailVerified: '2025-08-13T21:03:33.891Z'
	image: null
	createdAt: '2025-04-29T22:11:12.094Z'
	roles: Role[]
	organizationRoles: OrganizationRole[]
	entitlements: []
}

const COOKIE_OPTIONS = {
	httpOnly: true,
	secure: process.env.NODE_ENV === 'production',
	sameSite: 'lax' as const,
	maxAge: 60 * 60 * 24 * 90,
	path: '/',
} as const

export default auth(async function middleware(req) {
	const user = req.auth?.user as ReqUser | undefined
	const pathname = req.nextUrl.pathname
	const campaignLandingMatch = pathname.match(/^\/c\/([^/]+)\/([^/]+)\/?$/)

	if (campaignLandingMatch) {
		const campaignSlug = campaignLandingMatch[1]
		const variantSlug = campaignLandingMatch[2]
		const requestHost = req.headers.get('host') ?? req.nextUrl.host
		const requestProtocol = requestHost.includes('localhost')
			? 'http:'
			: req.nextUrl.protocol
		const requestOrigin = `${requestProtocol}//${requestHost}`
		const rewriteUrl = new URL(
			req.nextUrl.pathname + req.nextUrl.search,
			requestOrigin,
		)

		if (!campaignSlug || !variantSlug) {
			rewriteUrl.pathname = `/cohorts/${AI_CODING_COHORT_SLUG}`
			return NextResponse.rewrite(rewriteUrl)
		}

		const landing = getCampaignLanding(campaignSlug, variantSlug)

		if (!landing) {
			void log.warn('campaign_landing.fallback_rewrite', {
				campaignSlug,
				variantSlug,
				pathname,
				search: req.nextUrl.search,
				fallbackPath: `/cohorts/${AI_CODING_COHORT_SLUG}`,
			})
		}

		rewriteUrl.pathname = landing
			? `/_campaign/${campaignSlug}/${variantSlug}`
			: `/cohorts/${AI_CODING_COHORT_SLUG}`

		return NextResponse.rewrite(rewriteUrl)
	}

	const isAdmin = user?.roles?.some((role) => role.name === 'admin')
	const canViewAnalytics = user?.roles?.some(
		(role) => role.name === 'analytics_viewer',
	)
	if (pathname === '/admin' || pathname.startsWith('/admin/')) {
		// Analytics routes: allow admin OR analytics_viewer
		if (
			pathname === '/admin/analytics' ||
			pathname.startsWith('/admin/analytics/')
		) {
			if (!user || (!isAdmin && !canViewAnalytics)) {
				return NextResponse.rewrite(new URL('/not-found', req.url))
			}
		} else if (!user || !isAdmin) {
			return NextResponse.rewrite(new URL('/not-found', req.url))
		} else if (pathname === '/admin') {
			return NextResponse.redirect(new URL('/admin/dashboard', req.url))
		}
	}
	if (!user) return NextResponse.next()

	const currentOrgId = req.cookies.get('organizationId')?.value
	const response = NextResponse.next()

	const result = determineOrgAccess(user.organizationRoles, currentOrgId)

	if (result.action === 'REDIRECT_TO_ORG_LIST') {
		return NextResponse.redirect(new URL('/organization-list', req.url))
	}

	if (result.action === 'SET_OWNER_ORG' && result.organizationId) {
		response.cookies.set(
			'organizationId',
			result.organizationId,
			COOKIE_OPTIONS,
		)
		response.headers.set('x-organization-id', result.organizationId)
		return response
	}

	if (result.organizationId) {
		response.headers.set('x-organization-id', result.organizationId)
	}

	return response
})

export const config = {
	matcher: [
		'/((?!_next/static|_next/image|favicon.ico|_axiom/web-vitals|sitemap.xml|robots.txt).*)',
	],
}
