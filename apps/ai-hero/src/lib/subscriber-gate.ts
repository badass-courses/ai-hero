import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import type { CtaGatingSubscriber } from '@/lib/cta-gating'
import {
	createSubscriberGateSnapshot,
	parseSubscriberGateSnapshot,
	SUBSCRIBER_GATE_COOKIE,
} from '@/lib/cta/subscriber-gate-cookie'
import { SubscriberSchema, type Subscriber } from '@/schemas/subscriber'

/**
 * The subscriber, for deciding whether to render an ask — without paying a Kit
 * round-trip to find out.
 *
 * {@link getSubscriberFromCookie} is the right call when you need a CURRENT,
 * complete record: it re-fetches from Kit whenever the cookie is partial. That
 * is a third-party HTTP call, and CTA gating happens in the render path of
 * dynamic routes, so using it here would put api.kit.com in front of TTFB on
 * the homepage, every cohort page and every article — to decide whether to draw
 * a form.
 *
 * It does not need to. `setSubscriberCookie` stores the tiny completion facts
 * in `ck_subscriber_gate`. The separate snapshot matters because a long-time
 * Kit subscriber can exceed the browser's cookie-size limit; the browser
 * rejects that full-cookie update and otherwise leaves CTA gating stuck on an
 * older answer.
 *
 * The one case the cookie cannot answer is a reader arriving from a broadcast
 * link, where the middleware has set `ck_subscriber_id` from the URL but no
 * `ck_subscriber` exists yet. That genuinely needs the fetch, so it falls
 * through to `getSubscriberFromCookie` — which also populates the full cookie,
 * making it a once-per-reader cost rather than a per-request one.
 *
 * `cache()`d per request: several CTAs can sit on one page and they must not
 * each parse (or worse, each fetch) their own copy.
 */
export const getSubscriberForGating = cache(
	async (): Promise<Subscriber | null> => {
		const cookieStore = await cookies()
		if (!cookieStore) return null
		const gate = parseSubscriberGateSnapshot(
			cookieStore.get(SUBSCRIBER_GATE_COOKIE)?.value,
		)
		const cookie = cookieStore.get('ck_subscriber')?.value
		if (gate) {
			if (gate.email_address) return subscriberFromGate(gate)
			// Gate cookies written before email identity was added can borrow it
			// from the matching full cookie without a Kit round-trip. If that full
			// cookie was rejected for size, the caller correctly renders a form.
			if (cookie && cookie !== 'undefined') {
				try {
					const full = SubscriberSchema.parse(JSON.parse(cookie))
					if (full.id === gate.id && full.email_address) {
						return subscriberFromGate(gate, full.email_address)
					}
				} catch {}
			}
			return subscriberFromGate(gate)
		}

		if (cookie && cookie !== 'undefined') {
			try {
				const parsed = SubscriberSchema.parse(JSON.parse(cookie))
				// `email_address` missing means the record was written from a partial
				// source. Gating reads `state` and `fields`, neither of which the
				// address affects, so a partial record is still a usable answer —
				// this deliberately does NOT re-fetch the way the full read does.
				return parsed
			} catch {
				// A cookie we cannot parse is not evidence of a subscriber. Fall
				// through rather than returning null outright: the id cookie below
				// may still identify them.
			}
		}

		const subscriberIdCookie = cookieStore.get('ck_subscriber_id')?.value
		if (subscriberIdCookie) {
			try {
				return await getSubscriberFromCookie()
			} catch {
				// Kit being down must not take a page with it. A missing subscriber
				// shows the ask, which is what every visitor sees anyway.
				return null
			}
		}

		return getSubscriberForSession()
	},
)

/**
 * Whether the server can already name this reader, so a surface offers one
 * click instead of an email form. A cookie record with an address counts —
 * even an unconfirmed one, since resubscribing them is Kit's job, not the
 * reader's — and so does a session: they signed in from a link sent to that
 * address. Takes the already-resolved gating subscriber so callers who just
 * gated on it do not pay a second lookup.
 */
export async function hasKnownReaderIdentity(
	subscriber: { email_address?: string | null } | null,
): Promise<boolean> {
	if (subscriber?.email_address) return true
	try {
		const { getServerAuthSession } = await import('@/server/auth')
		const auth = await getServerAuthSession()
		return Boolean(auth?.session?.user?.email)
	} catch {
		return false
	}
}

const SESSION_KIT_LOOKUP_TIMEOUT_MS = 1_500

/**
 * The last resort: no Kit cookie of any kind, but the reader is signed in.
 *
 * A signed-in subscriber on a fresh browser has NO cookie to answer from, and
 * without this every gated ask on the site treated the person it knew best as
 * a stranger — closing every article by asking them to subscribe again. Their
 * session email is server-resolved (never caller input), so looking that
 * address up in Kit answers correctly.
 *
 * This is a third-party HTTP call in a render path, which the cookie paths
 * above exist to avoid — so it is bounded: it runs only when every cookie is
 * absent AND a session exists, it shares the request-level `cache()` with the
 * rest of the lookup, and it gives up after {@link
 * SESSION_KIT_LOOKUP_TIMEOUT_MS} in favour of showing the ask.
 */
async function getSubscriberForSession(): Promise<Subscriber | null> {
	try {
		const { getServerAuthSession } = await import('@/server/auth')
		const auth = await getServerAuthSession().catch(() => null)
		const email = auth?.session?.user?.email
		if (!email) return null

		const fromKit = await withTimeout(
			emailListProvider.getSubscriberByEmail(email),
			SESSION_KIT_LOOKUP_TIMEOUT_MS,
		)
		if (!fromKit) return null
		return SubscriberSchema.parse(fromKit)
	} catch {
		// Same direction as every other uncertain answer here: show the ask.
		return null
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race<T | null>([
			promise,
			new Promise<null>((resolve) => {
				timeout = setTimeout(() => resolve(null), timeoutMs)
			}),
		])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

function subscriberFromGate(
	gate: NonNullable<ReturnType<typeof parseSubscriberGateSnapshot>>,
	emailAddress = gate.email_address,
) {
	return SubscriberSchema.parse({
		...gate,
		state: gate.state ?? undefined,
		email_address: emailAddress,
	})
}

/**
 * The gating answer, and NOTHING else, for surfaces that can be asked by anyone.
 *
 * {@link getSubscriberForGating} is fine on the server, where it answers about
 * whoever's request it is. Exposed over tRPC it is not, for two reasons:
 *
 * 1. `ck_subscriber_id` is a plain cookie, and the middleware sets it from a
 *    query parameter on broadcast links — so it is CALLER-CONTROLLED. Letting an
 *    unauthenticated request drive the Kit fallback turns the endpoint into
 *    "fetch me the record for any subscriber id I name". This deliberately does
 *    not fall through to Kit: an id-only visitor gets `null`, and `null` means
 *    "show the ask", which is the safe direction and what every visitor sees.
 * 2. The full record carries `email_address`, `id` and name. Gating reads
 *    `state`, a handful of interest flags, and one boolean that says whether
 *    an identity exists. The identity value never leaves the server.
 *
 * `fields` is filtered rather than passed through because the keys are dynamic
 * (`waitlist_<product>`, `interest_<slug>`), and an allowlist of exact names
 * would have to be updated every time a product ships. Matching the shapes
 * gating actually reads keeps new products working without widening the payload
 * to whatever else Kit happens to be storing on a person.
 */
export const getCtaGatingPayload = cache(
	async (): Promise<CtaGatingSubscriber | null> => {
		const cookieStore = await cookies()
		if (!cookieStore) return null

		const gate = parseSubscriberGateSnapshot(
			cookieStore.get(SUBSCRIBER_GATE_COOKIE)?.value,
		)
		if (gate) {
			return {
				state: gate.state,
				fields: gate.fields,
				hasIdentity: Boolean(gate.email_address),
			}
		}

		const cookie = cookieStore.get('ck_subscriber')?.value
		if (!cookie || cookie === 'undefined') return null

		try {
			const parsed = SubscriberSchema.parse(JSON.parse(cookie))
			const snapshot = createSubscriberGateSnapshot(parsed)
			return {
				state: snapshot.state,
				fields: snapshot.fields,
				hasIdentity: Boolean(parsed.email_address),
			}
		} catch {
			return null
		}
	},
)
