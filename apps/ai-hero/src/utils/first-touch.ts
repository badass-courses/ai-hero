'use client'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FirstTouchAttribution {
	utm_source?: string
	utm_medium?: string
	utm_campaign?: string
	utm_content?: string
	utm_term?: string
	referrer?: string
	landing_path?: string
	landing_variant?: string
	ga_client_id?: string
	click_ids?: {
		gclid?: string
		gbraid?: string
		wbraid?: string
		fbclid?: string
		li_fat_id?: string
		ttclid?: string
		twclid?: string
	}
	params?: Record<string, string>
	captured_at: string
}

// ─── Config ──────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'ft_attr'
const COOKIE_TTL_DAYS = 90
const PAID_CLICK_ID_KEYS = [
	'gclid',
	'gbraid',
	'wbraid',
	'fbclid',
	'li_fat_id',
	'ttclid',
	'twclid',
] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setCookie(name: string, value: string, days: number): void {
	const expires = new Date()
	expires.setDate(expires.getDate() + days)
	document.cookie = [
		`${name}=${encodeURIComponent(value)}`,
		`expires=${expires.toUTCString()}`,
		'path=/',
		'SameSite=Lax',
	].join('; ')
}

function getCookieValue(name: string): string | null {
	const match = document.cookie
		.split('; ')
		.find((row) => row.startsWith(`${name}=`))
	if (!match) return null
	return decodeURIComponent(match.split('=').slice(1).join('='))
}

function compactParams(params: URLSearchParams): Record<string, string> {
	// This object may travel through Stripe metadata inside attributionSnapshot.
	// Keep it tiny. Do not store the whole URL query string here.
	return Object.fromEntries(
		[...params.entries()]
			.filter(([key]) => key.length <= 80)
			.slice(0, 30)
			.map(([key, value]) => [key, value.slice(0, 150)]),
	)
}

function extractLandingVariant(pathname: string): string | undefined {
	const match = pathname.match(/^\/c\/([^/]+)\/([^/]+)\/?$/)
	if (!match) return undefined

	return `${match[1]}/${match[2]}`
}

function extractGAClientId(): string | undefined {
	const gaCookie = getCookieValue('_ga')
	if (!gaCookie) return undefined

	const parts = gaCookie.split('.')
	if (parts.length >= 4) {
		return `${parts[2]}.${parts[3]}`
	}
	return undefined
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Capture first-touch attribution on the user's initial visit.
 * Idempotent, writes only if the ft_attr cookie doesn't already exist.
 * Reads UTM params from URL, referrer, landing path, and _ga cookie.
 * Stores as JSON in a 90-day first-party cookie.
 */
export function captureFirstTouch(): void {
	if (typeof document === 'undefined') return

	const existingRaw = getCookieValue(COOKIE_NAME)
	const params = new URLSearchParams(window.location.search)
	const allParams = compactParams(params)
	const hasPaidParams = [
		...PAID_CLICK_ID_KEYS,
		'utm_source',
		'utm_medium',
		'utm_campaign',
	].some((key) => params.has(key))

	// Keep first touch stable, but let explicit paid-test or paid-click visits repair
	// older cookies that predate the richer attribution payload.
	if (existingRaw && !hasPaidParams) return

	let existingAttribution: FirstTouchAttribution | null = null
	if (existingRaw) {
		try {
			existingAttribution = JSON.parse(existingRaw) as FirstTouchAttribution
		} catch {
			existingAttribution = null
		}
	}

	const attribution: FirstTouchAttribution = {
		...existingAttribution,
		captured_at: existingAttribution?.captured_at ?? new Date().toISOString(),
	}

	const utmSource = params.get('utm_source')
	if (utmSource) attribution.utm_source = utmSource

	const utmMedium = params.get('utm_medium')
	if (utmMedium) attribution.utm_medium = utmMedium

	const utmCampaign = params.get('utm_campaign')
	if (utmCampaign) attribution.utm_campaign = utmCampaign

	const utmContent = params.get('utm_content')
	if (utmContent) attribution.utm_content = utmContent

	const utmTerm = params.get('utm_term')
	if (utmTerm) attribution.utm_term = utmTerm

	const clickIds = Object.fromEntries(
		PAID_CLICK_ID_KEYS.flatMap((key) => {
			const value = params.get(key)
			return value ? [[key, value]] : []
		}),
	) as FirstTouchAttribution['click_ids']

	if (clickIds && Object.keys(clickIds).length > 0) {
		attribution.click_ids = {
			...attribution.click_ids,
			...clickIds,
		}
	}

	if (Object.keys(allParams).length > 0) {
		attribution.params = {
			...attribution.params,
			...allParams,
		}
	}

	if (document.referrer) {
		attribution.referrer = document.referrer
	}

	attribution.landing_path = window.location.pathname

	const landingVariant = extractLandingVariant(window.location.pathname)
	if (landingVariant) {
		attribution.landing_variant = landingVariant
	} else {
		delete attribution.landing_variant
	}

	const gaClientId = extractGAClientId()
	if (gaClientId) attribution.ga_client_id = gaClientId

	setCookie(COOKIE_NAME, JSON.stringify(attribution), COOKIE_TTL_DAYS)
}

/**
 * Read and parse the first-touch attribution cookie.
 * Returns null if not yet captured or if the cookie is malformed.
 */
export function readFirstTouch(): FirstTouchAttribution | null {
	if (typeof document === 'undefined') return null

	const raw = getCookieValue(COOKIE_NAME)
	if (!raw) return null

	try {
		return JSON.parse(raw) as FirstTouchAttribution
	} catch {
		return null
	}
}
