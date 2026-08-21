import { db } from '@/db'
import { userPrefs } from '@/db/schema'
import { guid } from '@coursebuilder/utils/guid'
import { and, desc, eq, isNull } from 'drizzle-orm'

import {
	parsePlaybackPrefFields,
	playbackPrefRecordFromRow,
	PLAYBACK_PREF_TYPE,
	type PlaybackPrefFields,
	type PlaybackPrefRecord,
} from './playback-prefs'

/**
 * Load the signed-in user's playback prefs from UserPrefs.
 * Missing rows mean the 540p default.
 */
export async function getPlaybackPrefsForUser(
	userId: string,
): Promise<PlaybackPrefRecord> {
	const row = await db.query.userPrefs.findFirst({
		where: and(
			eq(userPrefs.userId, userId),
			eq(userPrefs.type, PLAYBACK_PREF_TYPE),
			isNull(userPrefs.deletedAt),
		),
		orderBy: desc(userPrefs.updatedAt),
	})
	return playbackPrefRecordFromRow(row)
}

/**
 * Upsert the signed-in user's playback prefs. Cookie cache is the caller's job.
 */
export async function setPlaybackPrefsForUser(
	userId: string,
	patch: Partial<PlaybackPrefFields>,
): Promise<PlaybackPrefRecord> {
	const existing = await db.query.userPrefs.findFirst({
		where: and(
			eq(userPrefs.userId, userId),
			eq(userPrefs.type, PLAYBACK_PREF_TYPE),
			isNull(userPrefs.deletedAt),
		),
		orderBy: desc(userPrefs.updatedAt),
	})
	const current = parsePlaybackPrefFields(existing?.fields)
	const next: PlaybackPrefFields = {
		allowLowResolution:
			patch.allowLowResolution === undefined
				? current.allowLowResolution
				: patch.allowLowResolution === true,
	}

	if (existing) {
		await db
			.update(userPrefs)
			.set({
				fields: next,
				updatedAt: new Date(),
			})
			.where(eq(userPrefs.id, existing.id))
		return { ...next, stored: true }
	}

	await db.insert(userPrefs).values({
		id: guid(),
		userId,
		type: PLAYBACK_PREF_TYPE,
		fields: next,
	})
	return { ...next, stored: true }
}
