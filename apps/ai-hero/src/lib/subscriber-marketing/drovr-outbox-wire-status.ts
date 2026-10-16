import { NonRetriableError } from 'inngest'
import {
	ACK_TOMBSTONE_ENDPOINT,
	ACK_TOMBSTONE_EVENT_TYPE,
	ACK_TOMBSTONE_SOURCE,
	ACK_TOMBSTONE_STATUS,
} from './contact-sync-profile-ack-schema'

/** Explicit wire history allow-list. Control statuses never join this union;
 * new/unknown statuses cannot silently become dispatchable native work. */
export const DROVR_OUTBOX_WIRE_STATUSES = [
	'pending',
	'delivered',
	'rejected',
	'held',
	'superseded',
	'deferred',
] as const
export type DrovrOutboxWireStatus = (typeof DROVR_OUTBOX_WIRE_STATUSES)[number]
export const isOutboxWireStatus = (
	value: unknown,
): value is DrovrOutboxWireStatus =>
	DROVR_OUTBOX_WIRE_STATUSES.some((status) => status === value)
export class OutboxControlDispatchError extends NonRetriableError {
	readonly _tag = 'OutboxControlDispatch'
	constructor() {
		super(
			'OutboxControlDispatch: you tried to use control or unknown-state metadata as a wire row, and it failed because ACK tombstones are never events, signups, delivered receipts or rejections. Accepted: an explicitly allowed native wire status and events/signups endpoint with its real first body. Fix: keep the tombstone writer OFF until every reader filters control rows; inspect the control-only record without dispatching, releasing or recapturing it. Debug: ackTombstone status/source, control endpoint and fixed sentinel are non-wire fences; no HTTP or acknowledgement is authorized.',
		)
	}
}
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
/** Checks only typed fields/sentinel. Never reads lastError or scans prose. */
export function assertOutboxWireEntry(value: unknown): void {
	if (!record(value)) throw new OutboxControlDispatchError()
	const body = record(value.body) ? value.body : undefined
	if (
		value.control === ACK_TOMBSTONE_STATUS ||
		body?.control === ACK_TOMBSTONE_STATUS ||
		value.status === ACK_TOMBSTONE_STATUS ||
		value.source === ACK_TOMBSTONE_SOURCE ||
		value.endpoint === ACK_TOMBSTONE_ENDPOINT ||
		value.eventType === ACK_TOMBSTONE_EVENT_TYPE ||
		('status' in value && !isOutboxWireStatus(value.status)) ||
		('endpoint' in value &&
			value.endpoint !== 'events' &&
			value.endpoint !== 'signups')
	)
		throw new OutboxControlDispatchError()
}
export function assertOutboxWireRow(value: unknown): void {
	assertOutboxWireEntry(value)
	if (!record(value) || !isOutboxWireStatus(value.status))
		throw new OutboxControlDispatchError()
}
