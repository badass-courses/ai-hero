import 'server-only'

import { after } from 'next/server'
import { drovrApiKeyForTenant } from './drovr-shadow-emitter'
import { resolveDrovrApiBaseUrl } from './drovr-unsubscribe-page'
import {
	deliverProductEvents,
	productEventsEnabled,
	type ProductFact,
} from './product-events'

function report(outcome: string) {
	try {
		console.info('drovr.product_events', { outcome })
	} catch {
		/* Never fail commerce. */
	}
}

/** No network or database work until Next has sent the response. */
export function scheduleProductEvents(
	email: () => Promise<string | null | undefined>,
	facts: readonly ProductFact[],
) {
	if (!productEventsEnabled(process.env) || !facts.length) return
	try {
		after(async () => {
			try {
				const baseUrl = resolveDrovrApiBaseUrl({
					DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
					DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
				})
				const apiKey = drovrApiKeyForTenant('org-aihero')
				if (!baseUrl || !apiKey) {
					report('not-configured')
					return
				}
				report(
					await deliverProductEvents({
						email,
						facts,
						config: { baseUrl, apiKey },
					}),
				)
			} catch {
				report('failed')
			}
		})
	} catch {
		report('schedule-failed')
	}
}

/** Session metadata is the server's identity, not an email supplied by a URL. */
export function scheduleCheckoutProductEvents(
	session: { id: string; metadata: Record<string, string> | null },
	seats: number,
) {
	if (!productEventsEnabled(process.env)) return
	const userId = session.metadata?.userId
	if (!userId || !/^[A-Za-z0-9._/-]{1,200}$/.test(session.id)) return
	const at = Date.now()
	const facts: ProductFact[] = [
		{ _tag: 'CheckoutStep', step: 'started', sessionId: session.id, at },
	]
	if (seats > 1)
		facts.push({
			_tag: 'TeamIntent',
			intent: 'seats',
			sourceId: session.id,
			at,
		})
	scheduleProductEvents(async () => {
		const { courseBuilderAdapter } = await import('@/db')
		return (await courseBuilderAdapter.getUser?.(userId))?.email
	}, facts)
}
