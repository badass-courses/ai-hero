import { log } from '@/server/logger'

import {
	findRecordedJourneyOwner,
	isOwnerFanOutCandidate,
} from './drovr-ownership'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/**
 * Which contacts in a batch drovr owns, read from the live database. Both
 * delivery paths use it: the durable Inngest function and the direct
 * fallback. Imports are lazy because the host libraries that dispatch
 * facts must not load the database just to record one; a failed read
 * means no fan-out for this batch, logged, never a thrown error into the
 * host flow.
 */
export async function resolveOwnedContactIds(
	events: readonly DrovrShadowEvent[],
): Promise<string[]> {
	const candidates = new Set(
		events.filter(isOwnerFanOutCandidate).map((event) => event.contactId),
	)
	if (candidates.size === 0) return []
	try {
		const [{ db }, { DrizzleCaptureMarketingRepository }] = await Promise.all([
			import('@/db'),
			import('./drizzle-capture-repository'),
		])
		const repository = new DrizzleCaptureMarketingRepository(db)
		const owned: string[] = []
		for (const contactId of candidates) {
			if ((await findRecordedJourneyOwner(repository, contactId)) === 'drovr') {
				owned.push(contactId)
			}
		}
		return owned
	} catch (error) {
		try {
			await log.warn('drovr.owner.resolve_failed', {
				contacts: candidates.size,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {
			// Logging cannot make the read succeed.
		}
		return []
	}
}
