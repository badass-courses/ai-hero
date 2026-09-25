/**
 * The host Inngest calls ai-hero's functions on.
 *
 * The production sync (.github/workflows/ai-hero-inngest-sync.yaml) PUTs the
 * immutable deployment URL so a new deployment's functions register even
 * while www still aliases the old one. The SDK registers whatever URL it was
 * reached on, and deployment URLs sit behind Vercel Deployment Protection:
 * the sync's own PUT carries the bypass header, Inngest's later calls do not.
 * On 2026-09-25 17:07–17:10Z every run 401'd at the edge ("Protected
 * deployment") until another sync registered www again.
 *
 * In production the registered URL is always the public www host. Previews
 * and local dev keep the request host. An explicit INNGEST_SERVE_HOST wins.
 */
export const PRODUCTION_INNGEST_SERVE_HOST = 'https://www.aihero.dev'

export function inngestServeHost(
	env: Readonly<Record<string, string | undefined>>,
): string | undefined {
	const explicit = env.INNGEST_SERVE_HOST?.trim()
	if (explicit) return explicit
	return env.VERCEL_ENV === 'production'
		? PRODUCTION_INNGEST_SERVE_HOST
		: undefined
}
