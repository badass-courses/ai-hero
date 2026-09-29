export const VIDEO_ACCESS_VALUES = ['all', 'owned'] as const
export type VideoAccess = (typeof VIDEO_ACCESS_VALUES)[number]

export function parseVideoAccess(value: string | null | undefined): VideoAccess {
	return (VIDEO_ACCESS_VALUES as readonly string[]).includes(value ?? '')
		? (value as VideoAccess)
		: 'all'
}

/**
 * Stands in for an id list the viewer's status has not delivered yet, so a
 * "My courses" view renders empty-and-loading instead of briefly showing
 * everything. Typesense has no literal for "match nothing".
 */
const NO_MATCH_ID = '__pending__'

/**
 * The Typesense `filter_by` for /videos: every video the viewer can watch.
 *
 * - **all**: free videos — public posts and free-tier lessons — plus every
 *   lesson a course the viewer owns opens (`course_ids`).
 * - **owned**: only the lessons from the viewer's courses.
 *
 * Lessons are unlisted and often `draft` inside a live course, so their own
 * visibility and state say nothing; `free` and `course_ids` already require
 * an open, published course. `hiddenIds` removes watched videos.
 */
export function buildVideoSearchFilter({
	access,
	ownedIds,
	hiddenIds = [],
}: {
	access: VideoAccess
	/** `null` while the viewer's status is still loading. */
	ownedIds: ReadonlyArray<string> | null
	hiddenIds?: ReadonlyArray<string>
}): string {
	const parts = [
		'has_video:=true',
		'((visibility:=public && state:=published) || type:=lesson)',
	]
	const owned = ownedIds && ownedIds.length > 0 ? ownedIds : null
	const ownedClause = (ids: ReadonlyArray<string>) =>
		`course_ids:=[${ids.map(escapeFilterValue).join(',')}]`

	if (access === 'owned') {
		parts.push(ownedClause(owned ?? [NO_MATCH_ID]))
	} else {
		parts.push(owned ? `(free:=true || ${ownedClause(owned)})` : 'free:=true')
	}

	if (hiddenIds.length > 0) {
		parts.push(`id:!=[${hiddenIds.map(escapeFilterValue).join(',')}]`)
	}

	return parts.join(' && ')
}

/** Backtick-quote ids so a comma or bracket in one cannot break the filter. */
function escapeFilterValue(value: string) {
	return `\`${value.replace(/`/g, '')}\``
}
