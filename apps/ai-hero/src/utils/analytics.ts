/**
 * Fan one client event out to whichever analytics globals the page has
 * (gtag, Meta pixel, ahoy).
 *
 * This used to call `@skillrecordings/analytics`. That package is CJS with a
 * bare `require('lodash')` — the whole library, nothing tree-shaken — plus the
 * Pages Router runtime via `next/router`, and the nav imports it, so every
 * page paid ~50KB gz of client JS for two `isFunction` checks. Same hits, no
 * dependencies.
 */
type AnalyticsWindow = Window & {
	gtag?: (...args: unknown[]) => void
	fbq?: (...args: unknown[]) => void
	ahoy?: { track?: (event: string, params?: unknown) => void }
}

export async function track(event: string, params?: any) {
	console.debug(`track ${event}`, params)
	if (typeof window === 'undefined') return false
	const w = window as AnalyticsWindow
	if (typeof w.ahoy?.track === 'function') w.ahoy.track(event, params)
	if (typeof w.fbq === 'function') w.fbq('trackCustom', event, params)
	if (typeof w.gtag === 'function') w.gtag('event', event, params)
	return true
}
