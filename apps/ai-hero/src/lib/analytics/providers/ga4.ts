import { env } from '@/env.mjs'

import { createGA4Provider } from '@coursebuilder/analytics/providers/ga4'

const provider = createGA4Provider({
	propertyId: env.STATS_ANALYTICS_PROPERTY_ID ?? '',
	clientEmail: env.GOOGLE_ANALYTICS_CLIENT_EMAIL ?? '',
	privateKey: env.GOOGLE_ANALYTICS_PRIVATE_KEY ?? '',
})

export const {
	getTrafficOverview,
	getTopPages,
	getTrafficSources,
	getSessionsByDay,
} = provider

export default provider
