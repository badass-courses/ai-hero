import { AsyncLocalStorage } from 'node:async_hooks'
import { NonRetriableError } from 'inngest'
import { bulkClockBounds, type BulkClockSample } from './drovr-bulk-clock'

export const BULK_SLOT_TOLERANCE_MS = 300
export class BulkSlotExpiredError extends Error {
	constructor() {
		super(
			'BulkSlotExpired: you resumed a paced send, and it failed because its permit expired or was already spent. Accepted: one fresh permit per POST. Fix: re-reserve without consuming an HTTP attempt. Debug: inspect the reservation and wake times.',
		)
	}
}
export class BulkPaceYieldError extends Error {
	constructor() {
		super(
			'BulkPaceYield: you waited for paced capacity, and it failed because this run exhausted its bounded booking budget. Accepted: a durable capped handoff. Fix: queue the unchanged event, not a failed HTTP delivery. Debug: inspect the class backlog.',
		)
	}
}
const permit = new AsyncLocalStorage<{
	slot: number
	spent: boolean
	clock: BulkClockSample
}>()
const fresh = (slot: number, clock: BulkClockSample) => {
	const bounds = bulkClockBounds(clock)
	return (
		!!bounds &&
		bounds.lower >= slot &&
		bounds.upper <= slot + BULK_SLOT_TOLERANCE_MS
	)
}
export function withBulkPostPermit<T>(
	slot: number,
	send: () => Promise<T>,
	clock: BulkClockSample,
): Promise<T> {
	if (!fresh(slot, clock)) throw new BulkSlotExpiredError()
	return permit.run({ slot, spent: false, clock }, send)
}
/** Transport boundary, after asynchronous directory/logging work. Live sends
 * have no permit context and remain unpaced. Never turn expiry into an outage.
 */
export function assertBulkPostPermit(eventCount = 1): void {
	const active = permit.getStore()
	if (!active) return
	if (eventCount !== 1)
		throw new NonRetriableError(
			'BulkEnvelope: you attempted a capped POST, and it failed because it contains multiple events. Accepted: one event per permit. Fix: shard before delivery. Debug: inspect the capped envelope.',
		)
	if (active.spent || !fresh(active.slot, active.clock))
		throw new BulkSlotExpiredError()
	active.spent = true
}
