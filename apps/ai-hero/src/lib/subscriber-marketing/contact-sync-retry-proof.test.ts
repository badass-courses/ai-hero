import { describe, expect, it, vi } from 'vitest'
import { runContactSyncStragglerRetry } from './contact-sync-straggler-retry'
import type { RetryAcknowledgementProof } from './contact-sync-retry-acknowledgement'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const clock = '2032-01-01T00:00:00.000Z'
function fixture() {
	const event: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-proof-contact',
		journeyId: 'contact-directory',
		type: 'contact.links.issued',
		occurredAt: clock,
		idempotencyKey: 'synthetic-proof-links:3',
		payload: {
			profileVersion: 3,
			journeyId: 'crash-course-evergreen-offer',
			emailKey: 'synthetic-email',
			issuedAt: clock,
			expiresAt: '2032-05-01T00:00:00.000Z',
			variables: {},
			sendTimeFields: [],
		},
	}
	const acknowledge = vi.fn(async () => {})
	const hold = vi.fn(async (_input: unknown) => {})
	const prove = vi.fn(
		async (): Promise<RetryAcknowledgementProof> => ({
			proved: true,
			rejected: 0,
		}),
	)
	const publish = vi.fn(async (_id: string, _event: unknown) => {})
	const deliver = vi.fn(async () => ({ accepted: 1, rejected: 0 }))
	const args: Parameters<typeof runContactSyncStragglerRetry>[0] = {
		event: {
			data: {
				items: [{ event, reason: 'event-not-live' }],
				attempt: 2,
				firstFailedAt: clock,
				acknowledge: { contactId: event.contactId, profileVersion: 3 },
				paceClass: 'delta',
				deliverySource: 'contact-profile-sync',
				ownedKeys: ['a'.repeat(64), 'b'.repeat(64)],
			},
		},
		env: { AIH_DROVR_PROFILE_SYNC: 'true' },
		now: () => Date.parse(clock),
		runId: 'synthetic-proof-run',
		step: { run: async (_id, fn) => fn(), sendEvent: publish },
		deliver,
		birth: async () => {},
		warn: vi.fn(),
		acknowledge,
		holdBatch: hold,
		proveComplete: prove,
	}
	return { args, acknowledge, hold, prove, publish, deliver }
}

describe('whole-membership proof before logical ACK', () => {
	it('an accepted final link cannot ACK an earlier pending/unproved profile', async () => {
		const { args, prove, acknowledge, hold, publish } = fixture()
		prove.mockResolvedValue({
			proved: false,
			reason: 'synthetic earlier profile is still pending',
		})
		expect(await runContactSyncStragglerRetry(args)).toMatchObject({
			status: 'held',
			reason: 'unproven-delivery',
		})
		expect(hold).toHaveBeenCalledOnce()
		expect(acknowledge).not.toHaveBeenCalled()
		expect(publish).not.toHaveBeenCalled()
		expect(hold.mock.calls[0]![0]).toMatchObject({
			data: {
				firstFailedAt: clock,
				acknowledge: { profileVersion: 3 },
				ownedKeys: ['a'.repeat(64), 'b'.repeat(64)],
			},
		})
	})
	it('fresh retained rejection suppresses ACK without charging a new HTTP rejection', async () => {
		const { args, prove, acknowledge, hold } = fixture()
		prove.mockResolvedValue({ proved: true, rejected: 1 })
		expect(await runContactSyncStragglerRetry(args)).toMatchObject({
			status: 'delivered',
			accepted: 1,
			rejected: 0,
			priorRejected: 1,
		})
		expect(acknowledge).not.toHaveBeenCalled()
		expect(hold).not.toHaveBeenCalled()
	})
	it('an unproved rejection carry is not a completed batch either', async () => {
		const { args, acknowledge, hold } = fixture()
		args.event.data.rejectedCarry = 1
		expect(await runContactSyncStragglerRetry(args)).toMatchObject({
			status: 'held',
		})
		expect(acknowledge).not.toHaveBeenCalled()
		expect(hold).toHaveBeenCalledOnce()
	})
	it('only a fully proved nonrejected logical batch ACKs the declared version', async () => {
		const { args, prove, acknowledge, hold } = fixture()
		expect(await runContactSyncStragglerRetry(args)).toMatchObject({
			status: 'delivered',
			accepted: 1,
			rejected: 0,
		})
		expect(prove).toHaveBeenCalledOnce()
		expect(acknowledge).toHaveBeenCalledWith('synthetic-proof-contact', 3)
		expect(hold).not.toHaveBeenCalled()
	})
	it('ownership/admission runs before even a healthy flag-off publication', async () => {
		const { args, publish, deliver } = fixture()
		args.env = {}
		const order: string[] = []
		args.beforeDeliver = async () => {
			order.push('owned')
			args.event.data.items[0]!.event = {
				...args.event.data.items[0]!.event,
				occurredAt: clock,
			}
		}
		publish.mockImplementation(async () => {
			order.push('published')
		})
		expect(await runContactSyncStragglerRetry(args)).toMatchObject({
			status: 'rescheduled',
			attempt: 2,
		})
		expect(order).toEqual(['owned', 'published'])
		expect(deliver).not.toHaveBeenCalled()
	})
})
