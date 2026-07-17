const capabilityBearingVideoFields = new Set(['muxAssetId', 'muxPlaybackId'])

export function sanitizeResourcePayload(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sanitizeResourcePayload)
	}

	if (value instanceof Date || !value || typeof value !== 'object') {
		return value
	}

	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !capabilityBearingVideoFields.has(key))
			.map(([key, nestedValue]) => [key, sanitizeResourcePayload(nestedValue)]),
	)
}
