import 'server-only'
import { DROVR_PROFILE_ACK_ENABLED } from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flags-adapter'
import { redis } from '@/server/redis-client'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'

/** Fresh admin flag on every decision, like c5PricingClosed. Missing, failed
 * and timed-out reads are OFF in every environment; never changes a flag. */
export function profileAckEnabled(): Promise<boolean> {
	return profileAckFlagEnabled({
		readFlag: () => redis.get(getFlagKey(DROVR_PROFILE_ACK_ENABLED)),
	})
}
