import { renderCountdownGif } from '@/lib/email-countdown/render'
import { parseUntil, secondsLeft } from '@/lib/email-countdown/time'

/**
 * GET /api/email/countdown.gif?until=2026-11-03T07:59:59Z
 *
 * An animated countdown to `until` for marketing emails, rendered from the
 * request's clock so every open shows the time left at that moment. Public
 * and hot (every email open hits it): no auth, no cookies, no database, and
 * nothing read from the request but `until`.
 */

export const dynamic = 'force-dynamic'

const NO_CACHE = {
	'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
	Pragma: 'no-cache',
	Expires: '0',
} as const

export function GET(request: Request) {
	const now = new Date()
	const parsed = parseUntil(new URL(request.url).searchParams.get('until'), now)
	if (!parsed.ok) {
		return new Response(parsed.reason, {
			status: 400,
			headers: { ...NO_CACHE, 'Content-Type': 'text/plain; charset=utf-8' },
		})
	}

	const gif = renderCountdownGif(secondsLeft(parsed.until, now))
	return new Response(gif, {
		headers: {
			...NO_CACHE,
			'Content-Type': 'image/gif',
			'Content-Length': String(gif.byteLength),
		},
	})
}
