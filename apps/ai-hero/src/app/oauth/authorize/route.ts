import {
	checkAuthorizeRequest,
	clientRedirect,
} from '@/lib/learner-agent/oauth/authorize'
import { mintConsentTicket } from '@/lib/learner-agent/oauth/codes'
import { learnerOAuthUrls } from '@/lib/learner-agent/oauth/metadata'
import { oauthRateLimit } from '@/lib/learner-agent/oauth/rate-limit'
import { requestIp } from '@/lib/learner-agent/rate-limit'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

export const dynamic = 'force-dynamic'

const redirectTo = (location: string) =>
	new Response(null, {
		status: 302,
		headers: { Location: location, 'Cache-Control': 'no-store' },
	})

/**
 * `GET /oauth/authorize`: the authorization code flow's front door. It
 * validates everything first, sends a signed-out learner to log in and back,
 * then hands the validated request to the consent page as a sealed ticket
 * bound to that learner. It never issues a code itself.
 */
export async function GET(request: Request) {
	const urls = learnerOAuthUrls()
	const url = new URL(request.url)
	const showError = (reason: string) =>
		redirectTo(`${urls.consent}?error=${encodeURIComponent(reason)}`)

	if (!(await oauthRateLimit('authorize', requestIp(request))))
		return showError('rate_limited')

	const check = await checkAuthorizeRequest(url.searchParams, urls)
	if (!check.ok) {
		void log.warn('learner_agent.oauth', {
			outcome: `authorize_refused:${check.kind === 'show' ? check.reason : check.error}`,
		})
		if (check.kind === 'show') return showError(check.reason)
		return redirectTo(
			clientRedirect(
				check.redirectUri,
				{
					error: check.error,
					error_description: check.description,
					state: check.state,
				},
				urls,
			),
		)
	}

	const { session } = await getServerAuthSession()
	const userId = session?.user?.id
	if (!userId) {
		const back = `${url.pathname}${url.search}`
		return redirectTo(
			`${urls.baseUrl}/login?callbackUrl=${encodeURIComponent(back)}`,
		)
	}

	const ticket = mintConsentTicket(userId, check.request)
	if (!ticket) return showError('unavailable')
	return redirectTo(`${urls.consent}?ticket=${ticket}`)
}
