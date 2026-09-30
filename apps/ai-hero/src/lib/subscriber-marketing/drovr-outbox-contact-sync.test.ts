import { describe, expect, it, vi } from 'vitest'

vi.mock('./drovr-outbox-live', () => ({
	captureDrovrOutboxLive: vi.fn(),
	holdDrovrStopsLive: vi.fn(),
	settleDrovrOutboxLive: vi.fn(),
}))

import {
	DROVR_SETTLED_BY_STRAGGLER,
	settleOrHoldStragglerStops,
} from './drovr-outbox-contact-sync'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const event = (
	idempotencyKey: string,
	type: string,
	journeyId = 'contact-directory',
): DrovrShadowEvent =>
	({
		tenantId: 'org-aihero',
		contactId: 'contact-1',
		journeyId,
		type,
		occurredAt: '2026-09-30T12:00:00.000Z',
		idempotencyKey,
	}) as DrovrShadowEvent

const ports = () => ({
	settle: vi.fn(async (_entries: unknown, _note: string | null) => 0),
	hold: vi.fn(
		async (_entries: unknown, _reason: unknown, _httpStatus?: number) => ({
			status: 'outboxed' as const,
			count: 1,
		}),
	),
})

const keysOf = (entries: unknown) =>
	(entries as { idempotencyKey: string }[]).map((entry) => entry.idempotencyKey)

describe('the straggler retry settles or holds the stops it re-sends (row 204c)', () => {
	const unsubscribe = event('sync:unsubscribe', 'contact.unsubscribed')
	const bounce = event('sync:bounce', 'contact.bounced')
	const complaint = event('sync:complaint', 'contact.complained')
	const profile = event('sync:profile', 'contact.profile.updated')

	it('settles the stops drovr took, holds the one it refused, and leaves the one deferred again owed', async () => {
		const p = ports()
		const answer = await settleOrHoldStragglerStops(
			[unsubscribe, bounce, complaint, profile],
			{
				accepted: 2,
				rejected: 1,
				deferred: [{ event: complaint, reason: 'event-not-live' }],
				refused: [
					{
						event: bounce,
						httpStatus: 400,
						problem: { type: 'urn:drovr:problem:malformed-event' },
					},
				],
			},
			p,
		)
		expect(keysOf(p.settle.mock.calls[0]?.[0])).toEqual(['sync:unsubscribe'])
		expect(p.settle.mock.calls[0]?.[1]).toBe(DROVR_SETTLED_BY_STRAGGLER)
		expect(keysOf(p.hold.mock.calls[0]?.[0])).toEqual(['sync:bounce'])
		expect(p.hold.mock.calls[0]?.[1]).toContain('malformed-event')
		expect(p.hold.mock.calls[0]?.[2]).toBe(400)
		expect(answer).toEqual({
			accepted: 2,
			rejected: 1,
			deferred: [{ event: complaint, reason: 'event-not-live' }],
		})
	})

	it('settles an owner stop drovr says never started the journey, never holds it', async () => {
		const p = ports()
		const ownerStop = event(
			'owner:unsubscribe',
			'contact.unsubscribed',
			'crash-course-evergreen-offer',
		)
		await settleOrHoldStragglerStops(
			[ownerStop],
			{
				accepted: 0,
				rejected: 1,
				refused: [
					{
						event: ownerStop,
						httpStatus: 409,
						problem: { type: 'urn:drovr:problem:contact-never-born' },
					},
				],
			},
			p,
		)
		expect(p.hold).not.toHaveBeenCalled()
		expect(p.settle).not.toHaveBeenCalled()
	})

	it('touches nothing for a batch with no stops', async () => {
		const p = ports()
		await settleOrHoldStragglerStops([profile], { accepted: 1, rejected: 0 }, p)
		expect(p.settle).not.toHaveBeenCalled()
		expect(p.hold).not.toHaveBeenCalled()
	})
})
