export function contentDurationLabel({
	isVideo,
	durationSeconds,
	timeToReadSeconds,
}: {
	isVideo: boolean
	durationSeconds?: number | null
	timeToReadSeconds?: number | null
}): string | undefined {
	if (isVideo) {
		return durationSeconds && durationSeconds > 0
			? `${Math.max(1, Math.round(durationSeconds / 60))} min`
			: undefined
	}
	if (timeToReadSeconds && timeToReadSeconds > 0) {
		return `${Math.max(1, Math.round(timeToReadSeconds / 60))} min read`
	}
	return undefined
}

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const value = (obj as Record<string, unknown>)[key]
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(obj: unknown, key: string): number | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const value = (obj as Record<string, unknown>)[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

type ResourceJoin = {
	resource?: {
		type?: string
		fields?: unknown
	} | null
}

/**
 * Resolve the structural video signal and its real runtime. A post-level
 * duration stamp wins; the joined video resource covers older posts that were
 * published before that stamp existed.
 */
export function resolveContentDuration(
	fields: unknown,
	resources?: ResourceJoin[] | null,
): {
	isVideo: boolean
	durationSeconds?: number
	timeToReadSeconds?: number
} {
	const videoResource = resources?.find(
		(join) => join.resource?.type === 'videoResource',
	)?.resource
	const youtubeSource =
		readString(fields, 'youtubeUrl') || readString(fields, 'youtube')
	const isVideo = Boolean(videoResource) || Boolean(youtubeSource)

	return {
		isVideo,
		durationSeconds:
			readNumber(fields, 'duration') ??
			readNumber(videoResource?.fields, 'duration'),
		timeToReadSeconds: readNumber(fields, 'timeToRead'),
	}
}
