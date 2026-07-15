export type OptInAttribution = {
	utmSource?: string
	utmMedium?: string
	utmCampaign?: string
	utmContent?: string
	utmTerm?: string
	gclid?: string
	gbraid?: string
	wbraid?: string
	landingPath?: string
	capturedAt: string
	subscribedAt?: string
}

const MAX_VALUE_LENGTH = 255
const MAX_PATH_LENGTH = 500

function bounded(value: unknown, max = MAX_VALUE_LENGTH) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed ? trimmed.slice(0, max) : undefined
}

/** Parse the browser ft_attr cookie without retaining arbitrary params or identifiers. */
export function parseOptInAttributionCookie(raw?: string | null): OptInAttribution | undefined {
	if (!raw) return undefined
	try {
		const input = JSON.parse(raw) as Record<string, unknown>
		const clickIds =
			input.click_ids && typeof input.click_ids === 'object'
				? (input.click_ids as Record<string, unknown>)
				: {}
		const capturedAt = bounded(input.captured_at)
		if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) return undefined
		const result: OptInAttribution = {
			utmSource: bounded(input.utm_source),
			utmMedium: bounded(input.utm_medium),
			utmCampaign: bounded(input.utm_campaign),
			utmContent: bounded(input.utm_content),
			utmTerm: bounded(input.utm_term),
			gclid: bounded(clickIds.gclid),
			gbraid: bounded(clickIds.gbraid),
			wbraid: bounded(clickIds.wbraid),
			landingPath: bounded(input.landing_path, MAX_PATH_LENGTH),
			capturedAt,
		}
		return Object.values(result).some(Boolean) ? result : undefined
	} catch {
		return undefined
	}
}

export function isSyntheticOptInAttribution(value: OptInAttribution) {
	return [value.gclid, value.gbraid, value.wbraid].some((id) => id?.startsWith('TEST_'))
}
