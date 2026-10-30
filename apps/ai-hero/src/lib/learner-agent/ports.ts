import { log } from '@/server/logger'

import type { LearnerAgentPorts } from '@ai-hero/learner-agent'

import { makeContentPort } from './content'
import { makeEntitlementsPort } from './entitlements'
import { resolveLearner } from './identity'
import { offerStore } from './offer-store'
import { makeOffersPort } from './offers'
import { makeProgressPort } from './progress'
import { makeRateLimitPort } from './rate-limit'
import { makeSearchPort } from './search'
import { learnerSiteUrls } from './site'

/**
 * The ports for one request: who is calling, and the app's own reads behind
 * each port. Built at the route, used for one call, then dropped.
 */
export async function learnerAgentPortsFor(
	request: Request,
): Promise<LearnerAgentPorts> {
	const site = learnerSiteUrls()
	const country =
		request.headers.get('x-vercel-ip-country') ||
		process.env.DEFAULT_COUNTRY ||
		'US'

	return {
		learner: await resolveLearner(request),
		entitlements: makeEntitlementsPort({ baseUrl: site.baseUrl, country }),
		content: makeContentPort({ baseUrl: site.baseUrl }),
		progress: makeProgressPort(),
		search: makeSearchPort({ baseUrl: site.baseUrl }),
		offers: makeOffersPort({ country, store: offerStore }),
		audit: {
			read: (event) => void log.info('learner_agent.read', event),
		},
		rateLimit: makeRateLimitPort(request),
		site,
		onPortFailure: (port, error) =>
			void log.error('learner_agent.port_failed', {
				port,
				error: error instanceof Error ? error.message : String(error),
			}),
		onDefect: (capability, cause) =>
			void log.error('learner_agent.defect', {
				capability,
				cause: cause.slice(0, 2000),
			}),
	}
}
