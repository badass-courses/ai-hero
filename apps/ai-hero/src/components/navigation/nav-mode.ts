/**
 * Navigation mode selection for the navigation redesign.
 *
 * Two visible desktop navigation modes plus a minimal fallback, chosen purely
 * from the current pathname:
 *
 * - `full`    Full top nav, no sidebar. Homepage + course/sales + public pages.
 * - `hub`     Slim "hub" top nav + docs sidebar. Free learning / article /
 *             resource pages. The sidebar (Phase 3) carries the deep nav.
 * - `minimal` The current minimal nav. Editors, admin, auth, and account/utility
 *             flows that should not get the marketing or hub chrome.
 *
 * IMPORTANT — this is consumed client-side from `usePathname()` (the nav is
 * already a client component). It is a pure synchronous function of the path:
 * no `cookies()`/`headers()`, so it does NOT force dynamic rendering and cannot
 * affect page data/loading. See `plans/navigation-redesign.md` for the
 * rendering-safety rationale. Do not move this to the server via middleware.
 *
 * Classification strategy: FULL and MINIMAL prefixes are enumerated explicitly
 * from the route audit. Free-learning articles are served by the `/[post]`
 * catch-all, so their slugs cannot be enumerated — a single top-level segment
 * that is not a known FULL/MINIMAL route is treated as an article (`hub`).
 * Anything else unmatched falls back to `full` (the safe public default).
 */

export type NavMode = 'full' | 'hub' | 'minimal'

/**
 * Editors, admin, auth, account, and transactional/utility flows. These keep
 * the current minimal nav. Matched as path segments (exact or prefix), so
 * `/admin` matches `/admin/dashboard` but not `/administer-something`.
 */
const MINIMAL_PREFIXES = [
	'/admin',
	'/login',
	'/profile',
	'/team',
	'/activate',
	'/check-your-email',
	'/organization-list',
	'/settings',
	'/invoices',
	'/transfer',
	'/welcome',
	'/subscribe',
	'/thanks',
	'/newsletter',
	'/confirm',
	'/confirmed',
	'/preferences',
	'/unsubscribed',
	'/q',
	'/survey',
	'/error',
	'/oauth',
	'/discord',
	'/ask',
	'/boss',
	'/brand',
	'/md',
	'/lists',
	'/prompts',
] as const

/**
 * Homepage, course/sales, commerce, and public legal/info pages: full top nav,
 * no sidebar. `/` is handled separately as an exact match.
 */
const FULL_PREFIXES = [
	'/courses',
	'/workshops',
	'/cohorts',
	'/events',
	'/products',
	'/for-your-team',
	'/faq',
	'/privacy',
] as const

/**
 * Free learning / resource sections that get the hub nav + sidebar. New
 * learning routes (e.g. `/learn`, `/tools`, `/principles`) opt in here. Bare
 * top-level article slugs served by `/[post]` are also treated as `hub` via the
 * single-segment fallback below, so they need not be listed.
 */
const HUB_PREFIXES = [
	'/posts',
	'/skills',
	'/ai-coding-dictionary',
	'/learn',
	'/tools',
	'/principles',
] as const

/** Strip query/hash and trailing slash, lowercase. Always returns a leading slash. */
function normalize(pathname: string): string {
	const path = (pathname.split(/[?#]/)[0] || '').toLowerCase()
	const trimmed = path.replace(/\/+$/, '')
	if (trimmed === '') return '/'
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** True when `path` equals a prefix or sits beneath it as a path segment. */
function matchesPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`)
}

/** Editor sub-routes (`/x/edit`, `/x/new`) always use the minimal nav. */
function isEditorRoute(path: string): boolean {
	return /\/(edit|new)(\/|$)/.test(path)
}

/**
 * Choose the navigation mode for a pathname. Pure and synchronous; safe to call
 * during SSR and on the client with the same input → same output.
 */
export function getNavMode(pathname: string | null | undefined): NavMode {
	if (!pathname) return 'full'
	const path = normalize(pathname)

	if (path === '/') return 'full'
	if (isEditorRoute(path)) return 'minimal'
	if (MINIMAL_PREFIXES.some((p) => matchesPrefix(path, p))) return 'minimal'
	if (FULL_PREFIXES.some((p) => matchesPrefix(path, p))) return 'full'
	if (HUB_PREFIXES.some((p) => matchesPrefix(path, p))) return 'hub'

	// Unmatched single top-level segment (e.g. `/what-is-an-llm`) is an article
	// served by the `/[post]` catch-all → hub. Deeper/unknown paths fall back to
	// the safe public default.
	const segments = path.split('/').filter(Boolean)
	if (segments.length === 1) return 'hub'

	return 'full'
}
