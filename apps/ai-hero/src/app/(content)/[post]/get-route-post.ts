import { notFound } from 'next/navigation'
import { getCachedPostOrList } from '@/lib/posts-query'

/** Keep file probes out of every lookup used by the /[post] route. */
export async function getRoutePost(slug: string) {
	if (/\.[a-z]+/i.test(slug)) notFound()

	return getCachedPostOrList(slug)
}
