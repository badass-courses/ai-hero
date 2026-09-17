import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { resolveRestrictedVideoAccess } from '@/lib/restricted-video-access'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { eq } from 'drizzle-orm'

/**
 * Playback for a videoResource that is marked for ONE organization.
 *
 * The caller names a video; it never names an organization. Which org a viewer
 * belongs to comes from the database-backed session and nothing else, so a
 * request cannot assert its way into someone else's welcome video.
 *
 * The response is per-viewer, so it must never be stored by a shared cache —
 * hence `force-dynamic` and `no-store` on every path, success included.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

const getRestrictedVideoHandler = async (
	_request: NextRequest,
	props: { params: Promise<{ videoResourceId: string }> },
) => {
	const { videoResourceId } = await props.params

	try {
		if (!videoResourceId) {
			return NextResponse.json(
				{ error: 'Not found' },
				{ status: 404, headers: NO_STORE },
			)
		}

		const { session, ability } = await getServerAuthSession()

		const resource = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, videoResourceId),
			columns: { id: true, type: true, fields: true },
		})

		const access = resolveRestrictedVideoAccess({
			resource: resource ?? null,
			organizationRoles: session?.user?.organizationRoles,
			isAdmin: ability.can('manage', 'all'),
		})

		if (access.status === 'not-found') {
			return NextResponse.json(
				{ error: 'Not found' },
				{ status: 404, headers: NO_STORE },
			)
		}

		if (access.status === 'denied') {
			// One body for every denial. The reason is a log line, not a hint the
			// caller can use to tell "no such restriction" from "not your org".
			await log.warn('api.restricted-video.get.denied', {
				videoResourceId,
				reason: access.reason,
				userId: session?.user?.id ?? null,
			})

			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: NO_STORE },
			)
		}

		return NextResponse.json(access.video, { headers: NO_STORE })
	} catch (error) {
		await log.error('api.restricted-video.get.failed', {
			videoResourceId,
			error: error instanceof Error ? error.message : 'Unknown error',
		})

		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: NO_STORE },
		)
	}
}

export const GET = withSkill(getRestrictedVideoHandler)
