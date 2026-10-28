import 'server-only'

import {
	pageViewFact,
	productEventsEnabled,
} from '@/lib/subscriber-marketing/product-events'
import { scheduleProductEvents } from '@/lib/subscriber-marketing/product-events-live'

/** Render under Suspense: the teams page never waits for tracking identity. */
export async function ProductPageView({ pageId }: { pageId: string }) {
	if (!productEventsEnabled(process.env)) return null
	try {
		const fact = pageViewFact(pageId)
		if (!fact) return null
		const { getServerAuthSession } = await import('@/server/auth')
		const { session } = await getServerAuthSession()
		const email = session?.user?.email
		if (email) scheduleProductEvents(async () => email, [fact])
	} catch {
		/* Tracking cannot fail the page. */
	}
	return null
}
