import { Effect } from 'effect'
import type { MembershipScan } from './held-exit-recover'

export function readKitExitMembership(options: {
	apiKey: string
	subscriberId: string
	fetch: typeof fetch
	now: () => string
	maxPages?: number
}) {
	return Effect.succeed<MembershipScan>({ membership: 'unknown', sequenceId: 2625552,
		complete: false, pages: 0, subscribers: 0, startedAt: options.now(), completedAt: options.now() })
}
