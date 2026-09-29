import { unstable_cache } from 'next/cache'
import { cookies } from 'next/headers'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { resourceProgress, users } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { and, eq, isNotNull } from 'drizzle-orm'

import { getPurchasedResources } from './library-query'
import { ownedVideoPlayback } from './video-facts'
import { getCachedVideoGraph } from './video-facts-query'
import {
	EMPTY_VIDEO_VIEWER_STATUS,
	type VideoViewerStatus,
} from './video-viewer-status'

/**
 * The email Kit has for a subscriber id. Cached: a returning email-course
 * learner should not cost a Kit call per page view.
 */
const getKitSubscriberEmail = unstable_cache(
	async (subscriberId: string) => {
		const subscriber = await emailListProvider.getSubscriber(subscriberId)
		return subscriber?.email_address ?? null
	},
	['kit-subscriber-email'],
	{ revalidate: 60 * 60 * 24 },
)

/**
 * Who is looking. A signed-in session wins. Otherwise the email-course
 * `ck_subscriber` cookie — but only through its Kit subscriber id. The cookie
 * is client-settable, so its email is never trusted: Kit says which email that
 * id belongs to. Impersonating a learner then takes their Kit id, which is not
 * guessable from their email the way their email is.
 */
async function resolveViewer(): Promise<{
	userId: string
	signedIn: boolean
} | null> {
	const { session } = await getServerAuthSession()
	if (session?.user?.id) return { userId: session.user.id, signedIn: true }

	const cookie = (await cookies()).get('ck_subscriber')?.value
	if (!cookie) return null

	let subscriberId: string | null = null
	try {
		const id = (JSON.parse(cookie) as { id?: unknown })?.id
		if (typeof id === 'number' || typeof id === 'string') {
			subscriberId = String(id).trim().slice(0, 64) || null
		}
	} catch {
		return null
	}
	if (!subscriberId) return null

	const email = await getKitSubscriberEmail(subscriberId).catch(() => null)
	if (!email) return null

	const user = await db.query.users.findFirst({
		where: eq(users.email, email),
		columns: { id: true },
	})
	return user ? { userId: user.id, signedIn: false } : null
}

export async function getVideoViewerStatus(): Promise<VideoViewerStatus> {
	const viewer = await resolveViewer()
	if (!viewer) return EMPTY_VIDEO_VIEWER_STATUS

	const completed = await db
		.select({ resourceId: resourceProgress.resourceId })
		.from(resourceProgress)
		.where(
			and(
				eq(resourceProgress.userId, viewer.userId),
				isNotNull(resourceProgress.completedAt),
			),
		)
	const watchedIds = completed.flatMap((row) =>
		row.resourceId ? [row.resourceId] : [],
	)

	// Owned courses, and the paid-lesson playback that comes with them, need a
	// real sign-in: watching those lessons does too.
	if (!viewer.signedIn) {
		return { ...EMPTY_VIDEO_VIEWER_STATUS, watchedIds }
	}

	const [purchased, graph] = await Promise.all([
		getPurchasedResources(viewer.userId),
		getCachedVideoGraph(),
	])
	const ownedIds = Array.from(
		new Set(purchased.flatMap((row) => (row.resourceId ? [row.resourceId] : []))),
	)

	return {
		watchedIds,
		ownedIds,
		playback: ownedVideoPlayback(graph, ownedIds),
	}
}
