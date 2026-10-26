import { Buffer } from 'node:buffer'
import { expect, it, vi } from 'vitest'
import { NonRetriableError } from 'inngest'
import { contactSyncStarterRequests } from './contact-sync-straggler-retry'
import {
	contactSyncStarterBatches,
	sendContactSyncStarters,
	STARTER_SEND_MAX_BYTES,
	STARTER_SEND_MAX_EVENTS,
	stragglerOwnershipEnabled,
} from './contact-sync-starter-batches'

function request(index = 0, firstName = '') {
	return contactSyncStarterRequests(
		[
			{
				reason: 'event-not-live',
				event: {
					tenantId: 'org-aihero',
					contactId: `synthetic-batch-${index}`,
					journeyId: 'contact-directory',
					type: 'contact.profile.updated',
					occurredAt: '2032-01-01T00:00:00Z',
					idempotencyKey: `profile:synthetic-batch-${index}:1`,
					payload: {
						profileVersion: 1,
						email: 'synthetic@example.test',
						firstName,
						holds: [],
					},
				},
			},
		],
		Date.parse('2032-01-01T00:00:00Z'),
	)[0]!
}
it('more than the provider 5000-event send limit is split into deterministic bounded steps', async () => {
	const requests = Array.from({ length: 5001 }, (_, i) => request(i)),
		before = JSON.stringify(requests)
	const sendEvent = vi.fn(async (_id: string, _events: typeof requests) => {})
	await sendContactSyncStarters({ sendEvent }, 'defer-refused', requests)
	expect(sendEvent).toHaveBeenCalledTimes(51)
	expect(sendEvent.mock.calls[0]![0]).toBe('defer-refused')
	expect(sendEvent.mock.calls[1]![0]).toBe('defer-refused:chunk:1')
	expect(sendEvent.mock.calls.flatMap(([, events]) => events)).toEqual(requests)
	for (const [, events] of sendEvent.mock.calls) {
		expect(events.length).toBeLessThanOrEqual(STARTER_SEND_MAX_EVENTS)
		expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThanOrEqual(
			STARTER_SEND_MAX_BYTES,
		)
	}
	expect(JSON.stringify(requests)).toBe(before)
})
it('counts UTF-8 bytes, including array brackets and commas, rather than JS characters', () => {
	const requests = Array.from({ length: 100 }, (_, i) =>
		request(i, '🙂'.repeat(2500)),
	)
	const batches = contactSyncStarterBatches(requests)
	expect(batches.length).toBeGreaterThan(1)
	expect(batches.flat()).toEqual(requests)
	for (const batch of batches)
		expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
			STARTER_SEND_MAX_BYTES,
		)
})
it('allows the exact byte boundary and starts a new chunk before exceeding it', () => {
	const first = request(),
		base = Buffer.byteLength(JSON.stringify(first))
	const payload = first.data.items[0]!.event.payload as { firstName: string }
	payload.firstName = 'x'.repeat(STARTER_SEND_MAX_BYTES - 2 - base)
	const batches = contactSyncStarterBatches([first, request(1)])
	expect(Buffer.byteLength(JSON.stringify(batches[0]))).toBe(
		STARTER_SEND_MAX_BYTES,
	)
	expect(batches).toHaveLength(2)
})
it('an oversized individual event fails before ANY partial send and is never membership-split', async () => {
	const sendEvent = vi.fn(),
		requests = [request(), request(1, '🙂'.repeat(STARTER_SEND_MAX_BYTES))]
	await expect(
		sendContactSyncStarters({ sendEvent }, 'defer', requests),
	).rejects.toBeInstanceOf(NonRetriableError)
	expect(sendEvent).not.toHaveBeenCalled()
})
it.each([undefined, '', 'false', '1', 'TRUE', ' true ', 'true'])(
	'producer switch opts in only for exact true: %s',
	(value) => {
		expect(
			stragglerOwnershipEnabled({ AIH_DROVR_STRAGGLER_OWNER: value }),
		).toBe(value === 'true')
	},
)
it('empty input emits no send step', async () => {
	const sendEvent = vi.fn()
	await sendContactSyncStarters({ sendEvent }, 'defer', [])
	expect(sendEvent).not.toHaveBeenCalled()
})
it('replay keeps identical chunk IDs, event IDs, bodies, clocks and ACK scope', async () => {
	const requests = Array.from({ length: 101 }, (_, i) => request(i)),
		plans: unknown[][] = []
	for (let replay = 0; replay < 2; replay++) {
		const calls: unknown[] = []
		await sendContactSyncStarters(
			{
				sendEvent: async (id, events) => {
					calls.push([id, events])
				},
			},
			'defer',
			requests,
		)
		plans.push(calls)
	}
	expect(plans[0]).toEqual(plans[1])
})
