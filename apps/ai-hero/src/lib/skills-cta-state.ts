import 'server-only'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { hasCompletedConversionIntent } from '@/lib/cta/conversion-intent'
import { LRUCache } from 'lru-cache'

const KIT_LOOKUP_TIMEOUT_MS = 1_500

/**
 * Kit lookups by email, remembered briefly per instance. This lookup rides in
 * the per-navigation tRPC batch of every skill page for any signed-in reader
 * whose cookie is not already conclusive — a live external HTTP call that set
 * the whole batch's floor.
 *
 * TIERED memory, because the states differ in what staleness costs:
 * `subscribed` is terminal (nothing un-starts the course) and keeps five
 * minutes. `tag-me`/none are TRANSITIONAL — the learner-flow executor writes
 * `aih_course_started_at` to Kit asynchronously after signup, and this very
 * refresh is what repairs the cookie's stale answer — so they keep only a
 * minute: enough to absorb a navigation burst, shorter than the async lag it
 * must not mask. Only DEFINITIVE answers are cached — a timeout or Kit
 * outage is retried on the next request rather than pinned for the TTL.
 */
const KIT_MEMO_TERMINAL_MS = 5 * 60 * 1000
const KIT_MEMO_TRANSITIONAL_MS = 60 * 1000
const kitLookupCache = new LRUCache<string, SkillsCtaState | 'none'>({
	max: 2000,
	ttl: KIT_MEMO_TERMINAL_MS,
})

/** Test hook — the memo would otherwise leak state between cases. */
export function clearSkillsCtaKitLookupCache() {
	kitLookupCache.clear()
}

/**
 * Test probe for the tiered TTLs: fake timers cannot reach the clock the LRU
 * captured at module load, so tests assert the remaining TTL instead.
 */
export function kitLookupRemainingTtlForTests(email: string) {
	return kitLookupCache.getRemainingTTL(email)
}

/**
 * Which skills-course ask a reader should see. ONE resolver, because the two
 * surfaces that make this offer used to answer it differently:
 *
 * - The inline CTA derived it client-side from the Kit cookie alone, so a
 *   signed-in reader with no cookie fell through to a name-and-email form —
 *   asking a known person for an address the server already had.
 * - `/skills/subscribe` collapsed it to `subscribed` vs `show-form`, with no
 *   `tag-me` at all, so an AI Hero subscriber who had never joined the course
 *   was told they were already on it.
 *
 * Same reader, same offer, two different answers. This is the single place that
 * decides, so they cannot drift again.
 */
export type SkillsCtaState =
	/** Nobody we know. Ask for an address. */
	| 'fresh'
	/** On the AI Hero list, not the course. One click, and we may say so. */
	| 'tag-me'
	/** Signed in, unknown to Kit. One click, but do NOT claim they subscribed. */
	| 'account'
	/** Already taking the course. Make no ask. */
	| 'subscribed'

/** What a Kit record means, so no caller re-derives it. */
function fromRecord(
	record: { state?: string | null; fields?: any } | null | undefined,
): SkillsCtaState | null {
	if (record?.state !== 'active') return null
	return hasCompletedConversionIntent({ kind: 'skills-course' }, record)
		? 'subscribed'
		: 'tag-me'
}

/**
 * @param sessionEmail the SIGNED-IN reader's address, or undefined. Never take
 * this from client input: it decides who gets enrolled.
 */
export async function resolveSkillsCtaState(
	sessionEmail?: string | null,
): Promise<SkillsCtaState> {
	// A completed cookie answer is sufficient. An incomplete answer is refreshed
	// below because learner-flow completion happens after the signup request.
	const cookieRecord = await getSubscriberFromCookie().catch(() => null)
	const cookieState = fromRecord(cookieRecord)
	if (cookieState === 'subscribed') return cookieState

	// Course entry is completed asynchronously by the learner-flow executor,
	// which writes `aih_course_started_at` after the browser's cookie was saved.
	// A local `tag-me` answer is therefore not final: refresh it from Kit using
	// whichever trusted identity we have. This also repairs legacy/oversized
	// subscriber cookies without exposing the address to the client.
	const email = cookieRecord?.email_address ?? sessionEmail
	if (!email) return cookieState ?? 'fresh'

	// Signed in with no usable cookie: ask Kit who they are rather than falling
	// through to a form. This is the case that left an enrolled reader being
	// nagged to sign up for a course they were already taking.
	let fromKit: SkillsCtaState | null
	const remembered = kitLookupCache.get(email)
	if (remembered !== undefined) {
		fromKit = remembered === 'none' ? null : remembered
	} else {
		try {
			const record = await withTimeout(
				emailListProvider.getSubscriberByEmail(email),
				KIT_LOOKUP_TIMEOUT_MS,
			)
			fromKit = fromRecord(record as any)
			kitLookupCache.set(email, fromKit ?? 'none', {
				ttl:
					fromKit === 'subscribed'
						? KIT_MEMO_TERMINAL_MS
						: KIT_MEMO_TRANSITIONAL_MS,
			})
		} catch {
			fromKit = null
		}
	}
	if (fromKit) return fromKit

	// Known by account, on no list. Still one click — we have their address.
	return cookieState ?? (sessionEmail ? 'account' : 'fresh')
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
