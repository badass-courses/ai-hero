export const PLAYBACK_POSITION_FIELD = 'playbackPositionSeconds'

export function normalizePlaybackPosition(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null

	const position = typeof value === 'number' ? value : Number(value)

	if (!Number.isFinite(position) || position < 0) return null

	return Math.floor(position)
}

export function readPlaybackPosition(
	fields: Record<string, unknown> | null | undefined,
): number | null {
	return normalizePlaybackPosition(fields?.[PLAYBACK_POSITION_FIELD])
}

export function mergePlaybackPositionFields(
	fields: Record<string, unknown> | null | undefined,
	position: unknown,
): Record<string, unknown> {
	const normalizedPosition = normalizePlaybackPosition(position)

	if (normalizedPosition === null) return { ...(fields ?? {}) }

	return {
		...(fields ?? {}),
		[PLAYBACK_POSITION_FIELD]: normalizedPosition,
	}
}

export function getPlaybackStartTime({
	queryTime,
	savedTime,
}: {
	queryTime?: string | null
	savedTime?: number | null
}): number {
	return (
		normalizePlaybackPosition(queryTime) ??
		normalizePlaybackPosition(savedTime) ??
		0
	)
}

// A save this close to either end is not worth resuming: near the start
// there is nothing to skip, and near the end the video would finish almost
// as soon as it starts.
const RESUME_MIN_SECONDS = 5
const RESUME_TAIL_SECONDS = 10
const RESUME_TAIL_FRACTION = 0.05

/**
 * Where a lesson should start from its saved position, once the duration is
 * known. Returns 0 to restart: no usable save, a save in the first 5 s, or a
 * save inside the tail (the last 5% or the last 10 s, whichever is larger).
 */
export function getResumeStartTime({
	savedTime,
	duration,
}: {
	savedTime?: number | null
	duration: number
}): number {
	const saved = normalizePlaybackPosition(savedTime)
	if (saved === null || saved < RESUME_MIN_SECONDS) return 0
	if (!Number.isFinite(duration) || duration <= 0) return saved

	const tail = Math.max(duration * RESUME_TAIL_FRACTION, RESUME_TAIL_SECONDS)
	return saved >= duration - tail ? 0 : saved
}

export function createPlaybackPositionSaveQueue(
	save: (position: number) => Promise<unknown>,
) {
	let pending: Promise<unknown> | null = null

	return (position: number) => {
		const write = () => save(position).catch(() => undefined)
		pending = pending ? pending.then(write, write) : write()
		return pending
	}
}
