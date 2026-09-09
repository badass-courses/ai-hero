import { createEvergreenClaimHttp } from './evergreen-claim-http'
import { createVerifiedUserObservedSource } from '@/lib/subscriber-marketing/evergreen-offer-journey/verified-user-observed-source'

/** Activation requires reviewed composition, not an environment-only toggle.
 * No database, provider, adapter or secret is acquired in the disabled branch. */
export function composeEvergreenClaim(
	options:
		| { enabled: false }
		| {
				enabled: true
				boundary: Omit<
					Parameters<typeof createEvergreenClaimHttp>[0],
					'enabled' | 'application'
				>
				source: Parameters<typeof createVerifiedUserObservedSource>[0]
		  },
) {
	if (!options.enabled)
		return async (_request: Request) =>
			new Response(null, {
				status: 404,
				headers: {
					'Cache-Control': 'private, no-store',
					'Referrer-Policy': 'no-referrer',
				},
			})
	return createEvergreenClaimHttp({
		...options.boundary,
		enabled: true,
		application: createVerifiedUserObservedSource(options.source),
	})
}
export { evergreenPilotClaim as evergreenClaimHandler } from './evergreen-pilot'
