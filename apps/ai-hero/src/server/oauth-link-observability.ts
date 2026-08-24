import { log } from '@/server/logger'

import type { OAuthLinkCanaryEvent } from './oauth-link-intent'

function enqueueNonCritical(write: Promise<void>) {
	void write.catch(() => {
		// Canary transport is non-authoritative. The structured console write has
		// already happened before the buffered direct-ingest promise can reject.
	})
}

export function observeOAuthLinkCanary(
	event: OAuthLinkCanaryEvent,
): Promise<void> {
	const eventName = `auth.oauth-link.${event.action}`
	if (event.critical) {
		return log.error(eventName, event)
	}
	if (
		event.action === 'validation_denied' ||
		(event.action === 'link_result' && event.result === 'denied')
	) {
		enqueueNonCritical(log.warn(eventName, event))
		return Promise.resolve()
	}
	enqueueNonCritical(log.info(eventName, event))
	return Promise.resolve()
}
