import { cookies } from 'next/headers'
import { db } from '@/db'
import { resourceProgress, users } from '@/db/schema'
import { SubscriberSchema } from '@/schemas/subscriber'
import { getServerAuthSession } from '@/server/auth'
import { and, eq, isNotNull } from 'drizzle-orm'

import { getPurchasedResources } from './library-query'
import {
	EMPTY_VIDEO_VIEWER_STATUS,
	type VideoViewerStatus,
} from './video-viewer-status'

/**
 * Who is looking, without side effects. A signed-in session wins; otherwise the
 * email-course `ck_subscriber` cookie resolves to an existing user, the same
 * fallback `getModuleProgressForUser` uses so email-course learners see their
 * completions. Unlike the progress write path this never creates a user — a
 * read has no business minting accounts.
 */
async function resolveViewer(): Promise<{
	userId: string
	signedIn: boolean
} | null> {
	const { session } = await getServerAuthSession()
	if (session?.user?.id) return { userId: session.user.id, signedIn: true }

	const cookie = (await cookies()).get('ck_subscriber')
	if (!cookie) return null

	let json: unknown
	try {
		json = JSON.parse(cookie.value)
	} catch {
		return null
	}
	const email = SubscriberSchema.safeParse(json).data?.email_address
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

	const [completed, purchased] = await Promise.all([
		db
			.select({ resourceId: resourceProgress.resourceId })
			.from(resourceProgress)
			.where(
				and(
					eq(resourceProgress.userId, viewer.userId),
					isNotNull(resourceProgress.completedAt),
				),
			),
		// The subscriber cookie is client-settable, so it may reveal what a
		// viewer has watched (as module progress already does) but never what
		// someone bought.
		viewer.signedIn ? getPurchasedResources(viewer.userId) : [],
	])

	return {
		watchedIds: completed.flatMap((row) =>
			row.resourceId ? [row.resourceId] : [],
		),
		ownedIds: Array.from(
			new Set(purchased.flatMap((row) => (row.resourceId ? [row.resourceId] : []))),
		),
	}
}
