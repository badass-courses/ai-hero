import 'server-only'

import { C5_PRICING_ENABLED, FLAGS } from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flags-adapter'
import { getEnvironment } from '@/flags/flags-env'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

import { c5PricingDisabled } from './config'
import { c5Closed, C5_FLAG_TIMEOUT_MS } from './switch'

/**
 * The C5 switch every C5 surface obeys: display, checkout and team invoices.
 * It reads the admin flag fresh on every call, so a toggle at /admin/flags
 * takes effect on the next request.
 */
export function c5PricingClosed(): Promise<boolean> {
	return c5Closed({
		envDisabled: () => c5PricingDisabled(),
		readFlag: async () => {
			try {
				return await redis.get(getFlagKey(C5_PRICING_ENABLED))
			} catch (error) {
				await log.warn('c5.pricing.flag_read_failed', {
					error: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		flagDefault: FLAGS[C5_PRICING_ENABLED].defaultValue[getEnvironment()],
		timeoutMs: C5_FLAG_TIMEOUT_MS,
	})
}
