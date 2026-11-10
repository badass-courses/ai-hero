import 'server-only'

import { db } from '@/db'
import { log } from '@/server/logger'
import { getAbilityForResource } from '@/utils/get-current-ability-rules'
import {
	c5SignedPlaybackInventoryQuery,
	type C5PlaybackRow,
} from './c5-signed-playback-inventory'
import {
	selectLessonPlayback,
	signedPlaybackEnabled,
	type PlaybackTokens,
} from './signed-playback'

/** Not a server action and never cached: authorization and tokens are per request. */
export async function getSignedLessonPlayback({
	lessonId,
	workshopId,
	moduleSlug,
	lessonSlug,
	video,
}: {
	lessonId: string
	workshopId?: string
	moduleSlug: string
	lessonSlug: string
	video: {
		id: string
		muxPlaybackId?: string | null
		muxSignedPlaybackId?: string | null
	}
}): Promise<{ muxPlaybackId: string; tokens?: PlaybackTokens } | null> {
	const publicPlaybackId = video.muxPlaybackId
	if (!publicPlaybackId) return null
	const fallback = { muxPlaybackId: publicPlaybackId }
	const flag = process.env.AIH_SIGNED_PLAYBACK_RESOURCES
	if (!signedPlaybackEnabled(flag) || !video.muxSignedPlaybackId || !workshopId)
		return fallback

	// Reuse the exact lesson gate, not a separate purchase or membership rule.
	const { canViewLesson } = await getAbilityForResource(lessonSlug, moduleSlug)
	if (!canViewLesson) return null
	const emit = (event: string, data: Record<string, string | number>) => {
		// Telemetry must not be able to break the pilot's fail-open playback.
		try {
			void log.info(event, data).catch(() => {})
		} catch {}
	}
	try {
		const result = await db.execute(c5SignedPlaybackInventoryQuery())
		const inPilot = (result.rows as C5PlaybackRow[]).some(
			(row) =>
				row.resourceId === video.id &&
				row.lessonId === lessonId &&
				row.workshopId === workshopId,
		)
		return selectLessonPlayback({
			resourceId: video.id,
			publicPlaybackId,
			signedPlaybackId: video.muxSignedPlaybackId,
			canView: canViewLesson,
			inPilot,
			flag,
			keyId: process.env.MUX_SIGNING_KEY_ID,
			privateKey: process.env.MUX_SIGNING_KEY_PRIVATE,
			log: emit,
		})
	} catch {
		emit('video.signed_playback.fallback', {
			resourceId: video.id,
			reason: 'scope_lookup_failed',
		})
		return fallback
	}
}
