'use client'

import { useConvertkitSubscriberUrlParam } from '@/hooks/use-convertkit-subscriber-url-param'

/**
 * Broadcast links arrive with ?ck_subscriber_id={{ subscriber.id }}. The page
 * resolves that id server-side for the first render; this client component
 * persists it as the subscriber cookie (and cleans the URL) so the one-click
 * enroll action can identify the subscriber.
 */
export function SubscriberUrlParam() {
	useConvertkitSubscriberUrlParam()
	return null
}
