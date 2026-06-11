type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

export function resolvePurchaseGA4ClientId(fields: unknown) {
	const record = isRecord(fields) ? fields : {}
	const attribution = isRecord(record.attribution) ? record.attribution : {}
	const ga = isRecord(attribution.ga) ? attribution.ga : {}
	return stringValue(ga.clientId) ?? stringValue(record.gaClientId)
}
