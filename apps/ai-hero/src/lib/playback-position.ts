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
