import 'server-only'

import {
	LEARNER_AGENT_NOTICE,
	LEARNER_AGENT_RETIRED,
} from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flag-key'
import { decodeFlagValue } from '@/flags/flags-adapter'
import { redis } from '@/server/redis-client'

import { learnerAgentStage, type LearnerAgentStage } from './retirement'

/**
 * Fresh read on every request. Unset, unreadable or slow reads as `active`:
 * a flag store outage must not take the learner surface down, and after the
 * switch-off the learner tokens are revoked anyway.
 */
export async function readLearnerAgentStage(
	timeoutMs = 500,
): Promise<LearnerAgentStage> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			Promise.all([
				redis.get(getFlagKey(LEARNER_AGENT_NOTICE)),
				redis.get(getFlagKey(LEARNER_AGENT_RETIRED)),
			]).then(([notice, retired]) =>
				learnerAgentStage({
					notice: decodeFlagValue(notice),
					retired: decodeFlagValue(retired),
				}),
			),
			new Promise<LearnerAgentStage>((resolve) => {
				timer = setTimeout(() => resolve('active'), timeoutMs)
			}),
		])
	} catch {
		return 'active'
	} finally {
		clearTimeout(timer)
	}
}
