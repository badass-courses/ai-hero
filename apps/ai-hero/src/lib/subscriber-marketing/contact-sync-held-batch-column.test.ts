import { beforeEach, expect, it, vi } from 'vitest'
import {
	heldBatchPersistenceLive,
	heldBatchRowsLive,
} from './contact-sync-held-batch-drizzle'
import { runContactSyncStragglerRetry } from './contact-sync-straggler-retry'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const fake = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	writes: [] as Record<string, unknown>[],
}))
const missing = () =>
	Object.assign(
		new Error("Unknown column 'heldContinuation' in 'field list'"),
		{ errno: 1054 },
	)
vi.mock('@/db', () => ({
	db: {
		select(fields?: Record<string, unknown>) {
			const hasColumn = fields === undefined || 'heldContinuation' in fields
			const result = async () => {
				if (hasColumn) throw missing()
				return [fake.row]
			}
			const chain: any = {
				from: () => chain,
				where: () => chain,
				limit: result,
				then: (yes: any, no: any) => result().then(yes, no),
			}
			return chain
		},
		update() {
			return {
				set(value: Record<string, unknown>) {
					fake.writes.push(value)
					return {
						where: async () => {
							throw missing()
						},
					}
				},
			}
		},
	},
}))
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(async () => {}) } }))
const clock = '2032-01-01T00:00:00.000Z'
const target = 'synthetic-old-schema'
const event: DrovrShadowEvent = {
	tenantId: 'org-aihero',
	contactId: 'synthetic-old-schema-contact',
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
const entry = outboxEntryForEvent(event, 'bulkDelta')
const key = drovrOutboxDedupeKey(target, entry)
beforeEach(() => {
	fake.writes.length = 0
	fake.row = {
		...entry,
		id: 'synthetic-old-schema-row',
		target,
		dedupeKey: key,
		status: 'pending',
		attempts: 1,
		lastStatus: 503,
		lastError: 'synthetic original HTTP503',
		firstFailedAt: clock,
		nextAttemptAt: clock,
		lastAttemptAt: clock,
		deliveredAt: null,
		releasedAt: null,
		createdAt: clock,
	}
})

it('actual retained/metadata readers tolerate the old layout and never parse lastError as held state', async () => {
	const [row] = await heldBatchRowsLive(target, [key])
	expect(row).toMatchObject({
		lastError: 'synthetic original HTTP503',
		queueHandoffs: 0,
		queueMetadataInvalid: false,
	})
	expect(row).not.toHaveProperty('heldBatch')
	const store = await heldBatchPersistenceLive()
	await expect(store.read({ target, key })).resolves.toEqual({
		encoded: undefined,
		invalid: false,
	})
	expect(fake.writes).toEqual([])
})

it('actual parking adapter missing-column failure cannot reach ACK, publication or lastError fallback', async () => {
	const store = await heldBatchPersistenceLive()
	const acknowledge = vi.fn(async () => {})
	const publish = vi.fn(async () => {})
	await expect(
		runContactSyncStragglerRetry({
			event: {
				data: {
					items: [{ event, reason: 'event-not-live' }],
					attempt: 1,
					firstFailedAt: clock,
					acknowledge: { contactId: event.contactId, profileVersion: 3 },
				},
			},
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => Date.parse(clock),
			step: { run: async (_id, fn) => fn(), sendEvent: publish },
			deliver: async () => ({ accepted: 0, rejected: 0, outboxed: 1 }),
			birth: async () => {},
			warn: vi.fn(),
			acknowledge,
			holdBatch: async () => {
				await store.block({ target, key }, 'synthetic unresolved logical batch')
			},
		}),
	).rejects.toThrow(/OutboxControl: you.*column is missing/)
	expect(acknowledge).not.toHaveBeenCalled()
	expect(publish).not.toHaveBeenCalled()
	expect(fake.writes).toHaveLength(1)
	expect(fake.writes[0]).toHaveProperty('heldContinuation')
	expect(fake.writes[0]).not.toHaveProperty('lastError')
	expect(fake.row).toMatchObject({
		status: 'pending',
		lastError: 'synthetic original HTTP503',
	})
})
