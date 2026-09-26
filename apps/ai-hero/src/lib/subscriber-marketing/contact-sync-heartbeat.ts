import type { DrovrDeliveryConfig } from './drovr-shadow-emitter'

/** drovr's tenant heartbeat route sits beside its ingest route. */
export function contactSyncHeartbeatUrl(ingestUrl: string): string {
	return ingestUrl.replace(/\/events\/?$/, '/contact-sync/heartbeat')
}

/**
 * Tell drovr every contact change up to `syncedThrough` has landed. drovr
 * trusts synced profiles only while this watermark is recent, and answers
 * `advanced: false` for an older or equal one, so a repeat is harmless.
 * Anything but 200 throws: a heartbeat that did not land must not let the
 * reconcile's watermark advance.
 */
export async function postContactSyncHeartbeat(args: {
	config: DrovrDeliveryConfig
	syncedThrough: string
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<{ advanced: boolean }> {
	const fetcher = args.fetcher ?? fetch
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000)
	try {
		const response = await fetcher(
			contactSyncHeartbeatUrl(args.config.ingestUrl),
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${args.config.apiKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ syncedThrough: args.syncedThrough }),
				signal: controller.signal,
			},
		)
		if (response.status !== 200) {
			throw new Error(
				`drovr contact sync heartbeat answered ${response.status}`,
			)
		}
		const body = (await response.json().catch(() => ({}))) as {
			advanced?: unknown
		}
		return { advanced: body.advanced === true }
	} finally {
		clearTimeout(timeout)
	}
}
