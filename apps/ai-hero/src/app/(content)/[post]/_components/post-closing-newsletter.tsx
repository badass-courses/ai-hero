import { PostNewsletterCell } from '@/app/(content)/_components/post-related-newsletter'
import { isOnEmailList } from '@/lib/cta-gating'
import { getSubscriberForGating } from '@/lib/subscriber-gate'

/**
 * The reader-dependent half of an article's closing grid.
 *
 * This is the ONLY part of an article page that has to know who is reading, so
 * it is the only part that reads a cookie — and it does so behind a Suspense
 * boundary. That containment is the whole point: awaiting the subscriber in the
 * page body instead took fifteen article and list routes out of the prerender
 * manifest, trading the static shell of an entire page for one cell at the
 * bottom of it.
 *
 * Returns null for a subscriber. The grid it sits in counts its own children
 * (`auto-fit`), so related reading takes the full row without being told.
 */
export async function PostClosingNewsletter({
	postSlug,
}: {
	postSlug: string
}) {
	// A gating lookup that throws must cost the CELL, not the ARTICLE.
	//
	// This runs inside a Suspense boundary, and a boundary's fallback covers
	// pending — not rejected. An exception here keeps going until it finds an
	// error boundary, and the nearest one belongs to the route, so a failed
	// cookie read would replace a perfectly good article with an error page over
	// a signup form at the bottom of it.
	//
	// Falling back to SHOWING the ask is the same direction taken everywhere else
	// gating is uncertain (see `cta-gating`): an ask a subscriber sees twice is a
	// smaller failure than an offer nobody sees — and here, than no article.
	let subscriber = null
	try {
		subscriber = await getSubscriberForGating()
	} catch {
		subscriber = null
	}

	if (isOnEmailList(subscriber)) return null

	return (
		<PostNewsletterCell trackParams={{ post: postSlug, location: 'post' }} />
	)
}
