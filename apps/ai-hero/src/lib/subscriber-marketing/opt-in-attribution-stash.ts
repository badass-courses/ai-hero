import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'

/**
 * Kit custom field that carries opt-in attribution across the double-opt-in
 * confirmation boundary. The subscribe route stashes the browser's ft_attr
 * payload here for confirmation-required signups; the confirmation reconciler
 * lifts it back into the skills-newsletter/subscribed event. Without this
 * stash every paid-ad gclid dies with the request that captured it, because
 * enrollment now happens hours later from Kit data alone.
 */
export const AIH_OPTIN_ATTRIBUTION_FIELD = 'aih_optin_attribution'

const MAX_SERIALIZED_LENGTH = 1000
const MAX_VALUE_LENGTH = 255
const MAX_PATH_LENGTH = 500

const STRING_KEYS = [
	'utmSource',
	'utmMedium',
	'utmCampaign',
	'utmContent',
	'utmTerm',
	'gclid',
	'gbraid',
	'wbraid',
] as const

function bounded(value: unknown, max = MAX_VALUE_LENGTH) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed ? trimmed.slice(0, max) : undefined
}

function compactAttribution(value: OptInAttribution): OptInAttribution | undefined {
	const capturedAt = bounded(value.capturedAt)
	if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) return undefined
	const result: OptInAttribution = { capturedAt }
	for (const key of STRING_KEYS) {
		const item = bounded(value[key])
		if (item) result[key] = item
	}
	const landingPath = bounded(value.landingPath, MAX_PATH_LENGTH)
	if (landingPath) result.landingPath = landingPath
	const subscribedAt = bounded(value.subscribedAt)
	if (subscribedAt && !Number.isNaN(Date.parse(subscribedAt))) {
		result.subscribedAt = subscribedAt
	}
	const hasSignal = STRING_KEYS.some((key) => result[key]) || result.landingPath
	return hasSignal ? result : undefined
}

/**
 * Serialize attribution into a bounded JSON string for a Kit custom field.
 * Drops low-value keys before giving up when the payload runs long.
 */
export function serializeOptInAttributionForKit(
	value: OptInAttribution,
): string | undefined {
	const compact = compactAttribution(value)
	if (!compact) return undefined
	const dropOrder = ['landingPath', 'utmContent', 'utmTerm'] as const
	let candidate = { ...compact }
	let serialized = JSON.stringify(candidate)
	for (const key of dropOrder) {
		if (serialized.length <= MAX_SERIALIZED_LENGTH) break
		delete candidate[key]
		serialized = JSON.stringify(candidate)
	}
	return serialized.length <= MAX_SERIALIZED_LENGTH ? serialized : undefined
}

/**
 * Parse a stashed attribution payload back out of Kit subscriber fields.
 * Tolerates missing/blank/malformed values by returning undefined.
 */
export function parseStashedOptInAttribution(
	fields?: Record<string, unknown> | null,
): OptInAttribution | undefined {
	const raw = fields?.[AIH_OPTIN_ATTRIBUTION_FIELD]
	if (typeof raw !== 'string' || !raw.trim()) return undefined
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		return compactAttribution(parsed as OptInAttribution)
	} catch {
		return undefined
	}
}
