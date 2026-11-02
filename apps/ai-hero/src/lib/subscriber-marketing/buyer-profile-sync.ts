import { requestContactProfileSyncSafely } from './drovr-contact-profile-sync-requests'
import type { LifecycleContactEventSummary } from './lifecycle-contact-events'

/** Include persisted duplicates: a retry may be repairing a lost sync request. */
export function requestBuyerProfileSync(
	summary: Pick<LifecycleContactEventSummary, 'written' | 'decisions'>,
) {
	const events = new Map(summary.written.map((event) => [event.id, event]))
	for (const decision of summary.decisions) {
		if (decision.status === 'skipped' && decision.existing) {
			events.set(decision.existing.id, decision.existing)
		}
	}
	for (const event of events.values()) {
		requestContactProfileSyncSafely(
			{ contactId: event.contactId, reason: 'reconcile' },
			{ eventId: `buyer-profile:${event.id}` },
		)
	}
}
