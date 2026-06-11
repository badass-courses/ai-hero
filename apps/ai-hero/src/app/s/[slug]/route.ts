import { NextRequest, NextResponse } from 'next/server'
import { getShortlinkBySlug, recordClick } from '@/lib/shortlinks-query'
import { log } from '@/server/logger'

const UTM_PARAMS = [
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_content',
	'utm_term',
] as const

const PAID_CLICK_ID_PARAM_LIST = [
	'gclid',
	'gbraid',
	'wbraid',
	'fbclid',
	'li_fat_id',
	'ttclid',
	'twclid',
] as const

const ATTRIBUTION_QUERY_PARAMS = [
	...UTM_PARAMS,
	...PAID_CLICK_ID_PARAM_LIST,
] as const

const PAID_CLICK_ID_PARAMS = new Set<string>(PAID_CLICK_ID_PARAM_LIST)

function shouldOverrideDestinationParam(key: string) {
	return key.startsWith('utm_') || PAID_CLICK_ID_PARAMS.has(key)
}

/**
 * Builds the redirect URL while preserving only known attribution params.
 *
 * Paid ads should use direct final URLs, but this keeps accidental shortlink
 * use from dropping gclid, gbraid, wbraid, or UTM evidence before first-touch
 * capture runs on the destination page.
 *
 * @param destination - The stored destination URL for the shortlink.
 * @param requestUrl - The incoming shortlink request URL that may include UTM
 * params or paid click IDs such as gclid, gbraid, or wbraid.
 * @returns A URL object with only allowlisted attribution params merged into
 * the destination URL.
 */
export function buildShortlinkRedirectUrl(
	destination: string,
	requestUrl: string,
) {
	const redirectUrl = new URL(destination)
	const incomingParams = new URL(requestUrl).searchParams

	for (const key of ATTRIBUTION_QUERY_PARAMS) {
		const value = incomingParams.get(key)
		if (!value) continue
		if (
			!redirectUrl.searchParams.has(key) ||
			shouldOverrideDestinationParam(key)
		) {
			redirectUrl.searchParams.set(key, value)
		}
	}

	return redirectUrl
}

/**
 * Parse device type from user-agent string
 */
function parseDevice(userAgent: string | null): string | null {
	if (!userAgent) return null

	const ua = userAgent.toLowerCase()
	if (ua.includes('mobile') || ua.includes('android')) return 'mobile'
	if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet'
	return 'desktop'
}

/**
 * Route handler for shortlink redirects
 * Matches URLs like /s/[slug] and redirects to the corresponding URL
 * Records click analytics asynchronously
 */
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
	const { slug } = await params

	try {
		const link = await getShortlinkBySlug(slug)

		if (!link) {
			return new NextResponse('Shortlink not found', { status: 404 })
		}

		// Extract analytics metadata from request headers
		const referrer = request.headers.get('referer')
		const userAgent = request.headers.get('user-agent')
		const country = request.headers.get('x-vercel-ip-country')
		const device = parseDevice(userAgent)

		// Record click asynchronously - don't wait for it
		recordClick(slug, {
			referrer,
			userAgent,
			country,
			device,
		}).catch((error) => {
			log.error('shortlink.click.record.failed', {
				slug,
				error: String(error),
			})
		})

		// Set attribution cookie and redirect
		const response = NextResponse.redirect(
			buildShortlinkRedirectUrl(link.url, request.url),
		)
		response.cookies.set('sl_ref', slug, {
			maxAge: 60 * 60 * 24 * 30, // 30 days
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
		})

		return response
	} catch (error) {
		await log.error('shortlink.redirect.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			slug,
		})
		return new NextResponse('Internal Server Error', { status: 500 })
	}
}
