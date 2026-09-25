import { NextResponse, type NextRequest } from 'next/server'

import { env } from '@/env.mjs'
import { isSameOriginPost } from '@/lib/http/same-origin-post'
import {
	requestConfirmResend,
	submitConfirm,
} from '@/lib/subscriber-marketing/drovr-confirm-page'
import { resolveDrovrApiBaseUrl } from '@/lib/subscriber-marketing/drovr-unsubscribe-page'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

/**
 * POST /confirm/submit is the only place a double opt-in is confirmed (or a
 * new link requested). The /confirm page's GET only reads drovr's state
 * and renders the button: mail gateways open links, and a fetch must never
 * subscribe anyone. Only our own page's POST acts; anything else is 403
 * before the token is read. Answers 303 to /confirm with the outcome.
 */
export const POST = withSkill(async (request: NextRequest) => {
	if (!isSameOriginPost(request)) {
		await log.warn('confirm-page.cross_site_refused', {
			origin: request.headers.get('origin') ?? undefined,
			secFetchSite: request.headers.get('sec-fetch-site') ?? undefined,
		})
		return new NextResponse(null, { status: 403 })
	}
	const form = await request.formData().catch(() => undefined)
	const tokenValue = form?.get('t')
	const token = typeof tokenValue === 'string' ? tokenValue : undefined
	const action = form?.get('action') === 'resend' ? 'resend' : 'confirm'
	const config = { baseUrl: resolveDrovrApiBaseUrl(env) }
	const result =
		action === 'resend'
			? await requestConfirmResend(token, config)
			: await submitConfirm(token, config)

	// The token and the address are never logged.
	await log.info('confirm-page.submit', { action, result })

	const params = new URLSearchParams({ t: token ?? '', result })
	return NextResponse.redirect(
		new URL(`/confirm?${params.toString()}`, request.url),
		303,
	)
})
