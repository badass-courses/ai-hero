import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeHeldBatchContinuation } from '@/lib/subscriber-marketing/contact-sync-held-batch'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from '@/lib/subscriber-marketing/drovr-outbox'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'

const mocks = vi.hoisted(() => ({
	row: undefined as DrovrOutboxRow | undefined,
	send: vi.fn(),
	lease: vi.fn(),
	abort: vi.fn(),
	block: vi.fn(),
	rows: vi.fn(),
	direct: vi.fn(),
	warn: vi.fn(),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (
			_config: unknown,
			_trigger: unknown,
			handler: unknown,
		) => ({ handler }),
		send: mocks.send,
	},
}))
vi.mock('@/db', () => ({
	db: new Proxy(
		{},
		{
			get() {
				throw new Error('unexpected database access in replay controller test')
			},
		},
	),
}))
vi.mock('@/env.mjs', () => ({
	env: { DROVR_SHADOW_INGEST_URL: 'https://drovr.example.test/events' },
}))
vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/subscriber-marketing/drovr-outbox', async (original) => ({
	...(await original<
		typeof import('@/lib/subscriber-marketing/drovr-outbox')
	>()),
	runDrovrOutboxReplay: async (args: {
		post: (row: DrovrOutboxRow) => Promise<unknown>
	}) => args.post(mocks.row!),
}))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-drizzle', () => ({
	createDrizzleDrovrOutboxStore: () => ({
		leaseQueue: mocks.lease,
		abortQueueHandoff: mocks.abort,
	}),
}))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({
	drovrOutboxTargetFromEnv: () => 'synthetic-controller-target',
}))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-replay-post', () => ({
	postDrovrOutboxRow: mocks.direct,
}))
vi.mock('@/lib/subscriber-marketing/contact-sync-held-batch-drizzle', () => ({
	heldBatchPersistenceLive: async () => ({ block: mocks.block }),
	heldBatchRowsLive: mocks.rows,
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', () => ({
	deliverDrovrShadowEvent: vi.fn(),
	drovrApiKeyForTenant: vi.fn(),
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID: 'shadow-newsletter',
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({
	isNeverBornOwnerStop: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership', () => ({
	fanOutOwnedEvents: vi.fn(),
	isShadowNewsletterBirth: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership-live', () => ({
	resolveOwnedContactIds: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-doi-signup', () => ({
	parseDrovrSignupDeliveryConfig: () => undefined,
	postDrovrSignup: vi.fn(),
}))
vi.mock(
	'@/lib/subscriber-marketing/drovr-value-path-birth-admission-live',
	() => ({ readUnsubscribedValuePathContactIds: vi.fn() }),
)
import { drovrOutboxReplay } from './drovr-outbox-replay'

const clock = '2032-01-01T00:00:00.000Z'
const id = '00000000-0000-4000-8000-000000000001'
function fixture(released: boolean): DrovrOutboxRow {
	const event: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-controller-contact',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		occurredAt: clock,
		idempotencyKey: 'synthetic-profile:3',
		payload: {
			profileVersion: 3,
			email: 'learner@example.test',
			firstName: null,
			holds: [],
		},
	}
	// The first origin does not authorize direct HTTP when the coordinator is capped.
	const entry = outboxEntryForEvent(event, 'live')
	const key = drovrOutboxDedupeKey('synthetic-controller-target', entry)
	const row: DrovrOutboxRow = {
		...entry,
		target: 'synthetic-controller-target',
		dedupeKey: key,
		id: 'synthetic-controller-row',
		status: 'pending',
		attempts: 0,
		lastStatus: 503,
		lastError: 'synthetic HTTP503',
		firstFailedAt: clock,
		nextAttemptAt: clock,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: clock,
	}
	row.heldBatch = encodeHeldBatchContinuation({
		v: 1,
		release: released ? { state: 'released', id } : { state: 'held' },
		target: row.target,
		anchorKey: key,
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: { state: 'unfinished' },
		attempt: 2,
		rejectedCarry: 0,
		acknowledge: { contactId: event.contactId, profileVersion: 3 },
		members: [{ key, phase: 'pending', reason: 'event-not-live' }],
	})
	return row
}
const run = () =>
	(
		drovrOutboxReplay as unknown as {
			handler: (input: {
				step: {
					run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>
				}
			}) => Promise<unknown>
		}
	).handler({ step: { run: async (_id, fn) => fn() } })
beforeEach(() => {
	vi.clearAllMocks()
	mocks.row = fixture(false)
	mocks.lease.mockResolvedValue(true)
	mocks.send.mockResolvedValue({ ids: ['synthetic-command'] })
	mocks.rows.mockImplementation(async () => [mocks.row!])
	mocks.block.mockImplementation(async (_anchor, _reason, expected) => {
		if (mocks.row!.heldBatch !== expected.encoded) return false
		mocks.row!.heldBatchBlocked = true
		mocks.row!.status = 'held'
		return true
	})
})

describe('actual replay callback held-batch boundary (mocked storage/broker)', () => {
	it('valid held metadata never reaches lease, broker or direct HTTP', async () => {
		expect(await run()).toMatchObject({
			kind: 'held',
			detail: expect.stringContaining('HeldBatchContinuation:'),
		})
		expect(mocks.row!.status).toBe('held')
		expect(mocks.lease).not.toHaveBeenCalled()
		expect(mocks.send).not.toHaveBeenCalled()
		expect(mocks.direct).not.toHaveBeenCalled()
	})
	it('malformed retained metadata stays held and emits a literal prompt, not a broker failure or direct fallback', async () => {
		mocks.row!.heldBatch = '{'
		expect(await run()).toMatchObject({
			kind: 'held',
			detail: expect.stringContaining('HeldBatchContinuation:'),
		})
		expect(mocks.row!.status).toBe('held')
		expect(mocks.row!.heldBatch).toBe('{')
		expect(mocks.warn).toHaveBeenCalledWith(
			'drovr.outbox.held_batch_invalid',
			expect.objectContaining({ detail: expect.stringContaining('Accepted:') }),
		)
		expect(mocks.lease).not.toHaveBeenCalled()
		expect(mocks.send).not.toHaveBeenCalled()
		expect(mocks.direct).not.toHaveBeenCalled()
	})
	it('explicitly released metadata queues first stored bytes on its protected class even when the row first originated live', async () => {
		mocks.row = fixture(true)
		mocks.send.mockImplementation(async (envelope) => {
			expect(mocks.lease).toHaveBeenCalledOnce()
			expect(envelope.data.source).toBe('contact-profile-sync')
			expect(envelope.data.events).toEqual([])
			expect(envelope.data.stragglerRetry).toMatchObject({
				items: [{ event: mocks.row!.body }],
				firstFailedAt: clock,
				paceClass: 'delta',
				ownedKeys: [mocks.row!.dedupeKey],
			})
			return { ids: ['synthetic-command'] }
		})
		expect(await run()).toMatchObject({ kind: 'queued', phase: 'published' })
		expect(mocks.send).toHaveBeenCalledOnce()
		expect(mocks.direct).not.toHaveBeenCalled()
		expect(mocks.block).not.toHaveBeenCalled()
	})
})
