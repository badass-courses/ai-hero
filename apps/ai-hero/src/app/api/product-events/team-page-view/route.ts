import { getServerAuthSession } from '@/server/auth'
import {
	pageViewFact,
	productEventsEnabled,
} from '@/lib/subscriber-marketing/product-events'
import { scheduleProductEvents } from '@/lib/subscriber-marketing/product-events-live'

/** Fixed-page notification for the static teams page. Never accept a client
 * identity, timestamp, page or fact. No provider work is on this response path.
 */
export async function POST(request: Request) {
	if (!productEventsEnabled(process.env))
		return new Response(null, { status: 204 })
	try {
		const origin = request.headers.get('origin')
		if (origin && origin !== new URL(request.url).origin)
			return new Response(null, { status: 204 })
		const { session } = await getServerAuthSession()
		const email = session?.user?.email
		if (email)
			scheduleProductEvents(
				async () => email,
				[pageViewFact('/for-your-team')!],
			)
	} catch {
		/* This optional notification never fails a page visit. */
	}
	return new Response(null, { status: 204 })
}
