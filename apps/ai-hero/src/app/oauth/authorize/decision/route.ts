import { clientRedirect } from '@/lib/learner-agent/oauth/authorize'
import {
	mintAuthorizationCode,
	openConsentTicket,
} from '@/lib/learner-agent/oauth/codes'
import { learnerOAuthUrls } from '@/lib/learner-agent/oauth/metadata'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

export const dynamic = 'force-dynamic'

const seeOther = (location: string) =>
	new Response(null, {
		status: 303,
		headers: { Location: location, 'Cache-Control': 'no-store' },
	})

/**
 * Only our own consent page may post here. Browsers send `Origin` on every
 * form POST; a cross-site form carries the other site's origin.
 */
function fromOurOrigin(request: Request, baseUrl: string) {
	const origin = request.headers.get('origin')
	if (!origin) return false
	return (
		origin === new URL(baseUrl).origin || origin === new URL(request.url).origin
	)
}

/**
 * `POST /oauth/authorize/decision`: Approve or Deny from the consent page.
 * The ticket carries the validated request; the signed-in learner must be
 * the one it was minted for. Approve sends a 60-second code to the
 * client's redirect URI, Deny sends `access_denied`.
 */
export async function POST(request: Request) {
	const urls = learnerOAuthUrls()
	const showError = (reason: string) =>
		seeOther(`${urls.consent}?error=${encodeURIComponent(reason)}`)

	if (!fromOurOrigin(request, urls.baseUrl))
		return new Response('Forbidden', { status: 403 })

	const form = await request.formData().catch(() => null)
	const opened = openConsentTicket(form?.get('ticket'))
	if (!opened) return showError('expired')

	const { session } = await getServerAuthSession()
	if (!session?.user?.id || session.user.id !== opened.userId)
		return showError('wrong_account')

	const { request: approved, userId } = opened
	if (form?.get('decision') !== 'approve') {
		void log.info('learner_agent.oauth', {
			outcome: 'consent_denied',
			userId,
			clientHost: approved.clientHost,
		})
		return seeOther(
			clientRedirect(
				approved.redirectUri,
				{ error: 'access_denied', state: approved.state },
				urls,
			),
		)
	}

	const code = mintAuthorizationCode(userId, approved)
	if (!code) return showError('unavailable')
	void log.info('learner_agent.oauth', {
		outcome: 'consent_approved',
		userId,
		clientHost: approved.clientHost,
	})
	return seeOther(
		clientRedirect(approved.redirectUri, { code, state: approved.state }, urls),
	)
}
