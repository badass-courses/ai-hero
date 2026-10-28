import 'server-only'

import {
	normalizeResolveEmail,
	resolveDrovrContacts,
} from './drovr-purchase-resolve'

/** Wire shapes from GET https://api.drovr.sh/openapi.json, /product-events. */
export type ProductFact =
	| {
			_tag: 'PageViewed'
			at: number
			page: 'sales-page' | 'team-pricing'
			pageId: string
	  }
	| { _tag: 'CheckoutStep'; at: number; sessionId: string; step: 'started' }
	| {
			_tag: 'TeamIntent'
			at: number
			intent: 'seats' | 'invoice'
			sourceId: string
	  }

export function productEventsEnabled(env: Record<string, string | undefined>) {
	return (
		env.AIH_DROVR_PRODUCT_EVENTS_ENABLED === 'true' &&
		env.VERCEL_ENV !== 'preview'
	)
}

// Per-process, bounded refresh protection. drovr also deduplicates durably.
const pageViews = new Map<string, number>()
const HOUR = 3_600_000
function reservePage(contactId: string, fact: ProductFact, now: number) {
	if (fact._tag !== 'PageViewed') return true
	for (const [key, expires] of pageViews)
		if (expires <= now) pageViews.delete(key)
	const key = JSON.stringify([
		contactId,
		fact.pageId,
		Math.floor(fact.at / HOUR),
	])
	if (pageViews.has(key)) return false
	if (pageViews.size >= 10_000) pageViews.delete(pageViews.keys().next().value!)
	pageViews.set(key, now + HOUR)
	return true
}

type Outcome = 'sent' | 'skipped' | 'off' | 'failed' | 'timeout'

/** One 2.8s budget covers identity, resolve_contacts and the entire POST body.
 * The race also contains a dependency that ignores AbortSignal. No PII escapes.
 */
export async function deliverProductEvents(args: {
	email: () => Promise<string | null | undefined>
	facts: readonly ProductFact[]
	config: { baseUrl: string; apiKey: string }
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<Outcome> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<Outcome>((resolve) => {
		timer = setTimeout(
			() => {
				controller.abort()
				resolve('timeout')
			},
			Math.min(args.timeoutMs ?? 2800, 2800),
		)
	})
	const fetcher: typeof fetch = (input, init) =>
		(args.fetcher ?? fetch)(input, {
			...init,
			signal: init?.signal
				? AbortSignal.any([init.signal, controller.signal])
				: controller.signal,
		})
	const deliver = async (): Promise<Outcome> => {
		try {
			if (!args.facts.length || args.facts.length > 100) return 'skipped'
			const email = await args.email()
			if (!email || controller.signal.aborted) return 'skipped'
			const resolutions = await resolveDrovrContacts({
				emails: [email],
				config: args.config,
				fetcher,
				timeoutMs: 2800,
			})
			const contact = resolutions.get(normalizeResolveEmail(email))
			if (contact?.status !== 'resolved' || controller.signal.aborted)
				return 'skipped'
			const events = args.facts
				.filter((fact) => reservePage(contact.contactId, fact, Date.now()))
				.map((fact) => ({ contactId: contact.contactId, fact }))
			if (!events.length) return 'skipped'
			const response = await fetcher(
				`${args.config.baseUrl.replace(/\/+$/, '')}/product-events`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${args.config.apiKey}`,
						'content-type': 'application/json',
						accept: 'application/json',
					},
					body: JSON.stringify({ events }),
				},
			)
			// All forbidden responses are quiet; never log a provider problem body.
			if (response.status === 403) return 'off'
			if (!response.ok) return 'failed'
			const receipt = await response.json()
			return receipt.scope === 'product-facts' &&
				receipt.tenantId === 'org-aihero' &&
				Array.isArray(receipt.notStored) &&
				receipt.notStored.length === 0 &&
				Number.isInteger(receipt.inserted) &&
				Number.isInteger(receipt.repeats) &&
				receipt.inserted + receipt.repeats === events.length
				? 'sent'
				: 'failed'
		} catch {
			return controller.signal.aborted ? 'timeout' : 'failed'
		}
	}
	try {
		return await Promise.race([deliver(), timeout])
	} finally {
		clearTimeout(timer)
	}
}

export function pageViewFact(
	pageId: string,
	at = Date.now(),
): ProductFact | null {
	if (pageId === '/cohorts/software-factories-for-real-engineers-xdy1m')
		return { _tag: 'PageViewed', page: 'sales-page', pageId, at }
	if (pageId === '/for-your-team')
		return { _tag: 'PageViewed', page: 'team-pricing', pageId, at }
	return null
}
