'use server'

import { env } from '@/env.mjs'
import { getVideoSummary } from '@/lib/mux-data'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import type { VideoAnalyticsSummary } from '@coursebuilder/ui/cms/manifest'

/**
 * Ability-gated server action behind `bindings.videoAnalytics.summary` —
 * the per-video analytics strip in the cms editor's video preview dialog and
 * Video tab (same wiring pattern as `app/admin/video-dashboard/actions.ts`,
 * but gated on the EDITOR ability, `update Content`, not admin-only: the
 * strip is read-only numbers shown to people who can already edit the
 * resource).
 *
 * Returns null (the kit renders nothing — no data ≠ error) when:
 * - the caller can't edit content,
 * - Mux Data isn't configured (`MUX_DATA_TOKEN_ID`/`SECRET` unset),
 * - the video had no views in the window, or
 * - the Mux Data API errors (logged; the strip is never worth breaking
 *   the dialog over).
 */
export async function fetchVideoAnalyticsSummary(
	videoResourceId: string,
): Promise<VideoAnalyticsSummary | null> {
	const { ability } = await getServerAuthSession()
	if (ability.cannot('update', 'Content')) {
		return null
	}
	if (!env.MUX_DATA_TOKEN_ID || !env.MUX_DATA_TOKEN_SECRET) {
		return null
	}

	try {
		return await getVideoSummary(videoResourceId)
	} catch (error) {
		await log.error('cms.video-analytics.summary.failed', {
			videoResourceId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
