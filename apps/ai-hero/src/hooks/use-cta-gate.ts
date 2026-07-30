'use client'

import { api } from '@/trpc/react'

/**
 * The client half of CTA gating, for asks that live on a STATICALLY rendered
 * route.
 *
 * On a dynamic route the right answer is to resolve the subscriber on the
 * server and never send the CTA at all — see `getSubscriberForGating`. Three
 * routes are prerendered with ISR (`/newsletter`, `/learn`,
 * `/ai-coding-dictionary`), so their HTML is shared by everyone and the
 * decision has to happen after hydration. This is that path.
 *
 * `isResolved` exists because "we do not know yet" is a THIRD state, and the
 * two ways of collapsing it are not equally bad. Rendering the ask while the
 * query is in flight shows it to a subscriber for a moment and then removes it
 * — a flash and a reflow, but everyone sees the offer. Hiding it until the
 * query lands means the majority (non-subscribers, who the ask is for) get a
 * blank space that fills in late. Callers should render the ask optimistically
 * and only remove it once resolved; `isResolved` is here for the few places
 * that reserve space instead.
 */
export function useCtaGate() {
	const { data: subscriber, status } =
		api.ability.getSubscriberForCtaGating.useQuery(undefined, {
			// The answer lives in a cookie that only changes when this visitor
			// subscribes, which is a full navigation away. Without this the query
			// refetched on every mount and every window focus — and with the same
			// key shared by every CTA on the page, tabbing back to an article
			// re-ran it for all of them at once.
			staleTime: 5 * 60 * 1000,
			refetchOnWindowFocus: false,
			// One retry, not react-query's default three.
			//
			// Failing here means "we do not know who this is", and the fallback —
			// show the ask — is already the safe direction. Three retries with
			// exponential backoff instead kept the answer changing for several
			// seconds after the page had settled, so every CTA gated on this
			// re-rendered on each attempt. That is the "it loads, then loads
			// again" behaviour: not one slow request, but four spread over time.
			retry: 1,
		})

	return {
		subscriber: subscriber ?? null,
		/** False while the query is still in flight. */
		isResolved: status !== 'pending',
	}
}
