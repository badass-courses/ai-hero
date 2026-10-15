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
 * What the end card and the player need to know about where "next" goes.
 * The navigation keeps a lesson's video child only below a section (the
 * query strips it one level up), so flat workshops have no thumbnail.
 */
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
