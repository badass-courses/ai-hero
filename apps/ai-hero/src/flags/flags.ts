import { dedupe, flag } from '@vercel/flags/next'

import {
	C5_PRICING_ENABLED,
	COMMERCE_ENABLED,
	FLAGS,
	SHOW_TEAM_PRICING,
	SUBSCRIBE_BOT_SHADOW,
	SUBSCRIBE_BOT_ENFORCE,
} from './flag-definitions'
import { redisAdapter } from './flags-adapter'
import { getEnvironment, getEnvKey } from './flags-env'

export type FlagOption<T> = {
	value: T
	label: string
}

export { FLAG_PREFIX } from './flag-key'

// Common identify function for all flags
const identify = dedupe(async () => {
	return {
		user: {
			// TODO: Add actual user context from your auth system
			authenticated: false,
		},
	}
})

// Create the flag instances with environment-specific keys
export const commerceEnabled = flag<boolean>({
	key: getEnvKey(FLAGS[COMMERCE_ENABLED].key),
	adapter: redisAdapter(),
	defaultValue: FLAGS[COMMERCE_ENABLED].defaultValue[getEnvironment()],
	identify,
	options: FLAGS[COMMERCE_ENABLED].options,
})

export const showTeamPricingFlag = flag<boolean>({
	key: getEnvKey(FLAGS[SHOW_TEAM_PRICING].key),
	adapter: redisAdapter(),
	defaultValue: FLAGS[SHOW_TEAM_PRICING].defaultValue[getEnvironment()],
	identify,
	options: FLAGS[SHOW_TEAM_PRICING].options,
})

// Display only, for /admin/flags. C5 surfaces read the switch through
// c5PricingClosed, which fails closed and bounds the read.
export const c5PricingEnabledFlag = flag<boolean>({
	key: getEnvKey(FLAGS[C5_PRICING_ENABLED].key),
	adapter: redisAdapter(),
	defaultValue: FLAGS[C5_PRICING_ENABLED].defaultValue[getEnvironment()],
	identify,
	options: FLAGS[C5_PRICING_ENABLED].options,
})

export const subscribeBotShadowFlag = flag<boolean>({
	key: getEnvKey(FLAGS[SUBSCRIBE_BOT_SHADOW].key),
	adapter: redisAdapter(),
	defaultValue: FLAGS[SUBSCRIBE_BOT_SHADOW].defaultValue[getEnvironment()],
	identify,
	options: FLAGS[SUBSCRIBE_BOT_SHADOW].options,
})

export const subscribeBotEnforceFlag = flag<boolean>({
	key: getEnvKey(FLAGS[SUBSCRIBE_BOT_ENFORCE].key),
	adapter: redisAdapter(),
	defaultValue: FLAGS[SUBSCRIBE_BOT_ENFORCE].defaultValue[getEnvironment()],
	identify,
	options: FLAGS[SUBSCRIBE_BOT_ENFORCE].options,
})

// Map of flag keys to their instances
export const flagInstances = {
	[COMMERCE_ENABLED]: commerceEnabled,
	[SHOW_TEAM_PRICING]: showTeamPricingFlag,
	[C5_PRICING_ENABLED]: c5PricingEnabledFlag,
	[SUBSCRIBE_BOT_SHADOW]: subscribeBotShadowFlag,
	[SUBSCRIBE_BOT_ENFORCE]: subscribeBotEnforceFlag,
} as const

// Array of flags for precomputation
export const precomputeFlags = [
	commerceEnabled,
	showTeamPricingFlag,
	c5PricingEnabledFlag,
]

// Re-export types and constants
export type { FlagKey } from './flag-definitions'
export { FLAGS } from './flag-definitions'
