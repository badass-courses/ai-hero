import { Buffer } from 'node:buffer'
import { NonRetriableError } from 'inngest'
import type { contactSyncStarterRequests } from './contact-sync-straggler-retry'

type Starter = ReturnType<typeof contactSyncStarterRequests>[number]
export const STARTER_SEND_MAX_EVENTS = 100
// Conservative application budget, below the smallest published 256-KiB
// per-event plan limit; includes UTF-8 JSON brackets/commas, with headroom.
export const STARTER_SEND_MAX_BYTES = 240 * 1024

/** Preflight the WHOLE plan before sending any chunk; never split a contact's
 * immutable membership/ACK scope to make an oversized individual event fit. */
export function contactSyncStarterBatches(requests: Starter[]): Starter[][] {
	const batches: Starter[][] = []
	let batch: Starter[] = [],
		bytes = 2
	for (const request of requests) {
		const size = Buffer.byteLength(JSON.stringify(request), 'utf8')
		if (size + 2 > STARTER_SEND_MAX_BYTES)
			throw new NonRetriableError(
				'StragglerStarter: individual event exceeds safe send byte budget',
			)
		if (
			batch.length === STARTER_SEND_MAX_EVENTS ||
			bytes + size + Number(batch.length > 0) > STARTER_SEND_MAX_BYTES
		) {
			batches.push(batch)
			batch = []
			bytes = 2
		}
		bytes += size + Number(batch.length > 0)
		batch.push(request)
	}
	if (batch.length) batches.push(batch)
	return batches
}

export async function sendContactSyncStarters(
	step: { sendEvent(id: string, payload: Starter[]): Promise<unknown> },
	id: string,
	requests: Starter[],
) {
	const batches = contactSyncStarterBatches(requests)
	for (const [index, batch] of batches.entries())
		// Keep the old first-step ID for already queued histories. Later IDs
		// and layouts depend only on the retained input, never on wall time.
		await step.sendEvent(index === 0 ? id : `${id}:chunk:${index}`, batch)
}
