import {
	findParentLessonForSolution,
	flattenNavigationResources,
	isCompletionTrackedResource,
	type ResourceNavigation,
} from '@/lib/content-navigation'
import pluralize from 'pluralize'

import type { ContentResource } from '@coursebuilder/core/schemas'

export type NextLesson = {
	resource: ContentResource
	/** A solution is titled after its lesson. */
	title: string
	href: string
	isSolution: boolean
	/** Place among the workshop's tracked lessons; null for a solution. */
	number: number | null
	total: number
	thumbnailUrl: string | null
}

/**
 * A still of a lesson's video, through the app's immutable thumbnail route.
 * Without `time` the route uses the video's own thumbnail time.
 */
export function getLessonThumbnailUrl(
	resource: ContentResource | null,
	time?: number,
) {
	const videoId = resource?.resources?.find(
		(r) => r.resource?.type === 'videoResource',
	)?.resourceId
	if (!videoId) return null
	const url = `/api/thumbnails?videoResourceId=${encodeURIComponent(videoId)}`
	return time === undefined ? url : `${url}&time=${time}`
}

/**
 * The still at full player width, shown while a lesson the player swapped to
 * loads: frame 0 under autoplay (it starts there), else the lesson's own
 * poster frame. The previous lesson preloads this exact URL from the
 * navigation, which carries `thumbnailTime` for that reason.
 */
export function getArrivalPosterUrl(
	resource: ContentResource | null,
	{ fromStart }: { fromStart: boolean },
) {
	const time = fromStart ? 0 : Number(resource?.fields?.thumbnailTime) || 0
	const url = getLessonThumbnailUrl(resource, time)
	return url && `${url}&width=720`
}

/** What the end card and the player need to know about where "next" goes. */
export function getNextLesson({
	navigation,
	next,
	moduleType,
}: {
	navigation: ResourceNavigation | null
	next: ContentResource | null | undefined
	moduleType: 'workshop' | 'tutorial'
}): NextLesson | null {
	const moduleSlug = navigation?.fields?.slug
	if (!next || !moduleSlug) return null

	const isSolution = next.type === 'solution'
	const lesson = isSolution
		? findParentLessonForSolution(navigation, next.id)
		: next
	const slug = lesson?.fields?.slug
	if (!slug) return null

	const tracked = flattenNavigationResources(navigation).filter(
		isCompletionTrackedResource,
	)
	const index = tracked.findIndex((r) => r.id === next.id)

	return {
		resource: next,
		title: lesson.fields?.title || 'Next lesson',
		href: `/${pluralize(moduleType)}/${moduleSlug}/${slug}${isSolution ? '/solution' : ''}`,
		isSolution,
		number: index === -1 ? null : index + 1,
		total: tracked.length,
		thumbnailUrl: isSolution ? null : getLessonThumbnailUrl(next),
	}
}
