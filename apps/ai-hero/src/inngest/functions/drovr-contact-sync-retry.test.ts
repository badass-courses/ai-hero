import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import type { DrovrBatchOutcome } from '@/lib/subscriber-marketing/drovr-shadow-delivery'
const mocks = vi.hoisted(() => ({
	deliver: vi.fn(
		async (_args: {
			events: DrovrShadowEvent[]
		}): Promise<DrovrBatchOutcome> => ({ accepted: 1, rejected: 0 }),
	),
	reserve: vi.fn(async () => 0),
	settle: vi.fn(async () => 1),
	acknowledge: vi.fn(async () => {}),
	warn: vi.fn(),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({
	env: { DROVR_SHADOW_INGEST_URL: 'https://drovr.example.test/events' },
}))
vi.mock('@/server/logger', () => ({ log: { warn: mocks.warn } }))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({
	deliverBatchOrThrow: mocks.deliver,
}))
vi.mock(
	'@/lib/subscriber-marketing/drovr-shadow-emitter',
	async (original) => ({
		...(await original<
			typeof import('@/lib/subscriber-marketing/drovr-shadow-emitter')
		>()),
		drovrApiKeyForTenant: () => 'synthetic-test-key',
	}),
)
vi.mock('@/lib/subscriber-marketing/drovr-bulk-pace', async (original) => ({
	...(await original<
		typeof import('@/lib/subscriber-marketing/drovr-bulk-pace')
	>()),
	waitForBulkSlot: mocks.reserve,
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {
		async findContactById(id: string) {
			return {
				id,
				email: 'learner@example.test',
				createdAt: new Date('2026-10-01T00:00:00Z'),
				meta: {},
			}
		}
	},
}))
vi.mock('@/lib/subscriber-marketing/contact-kit-identity-drizzle', () => ({
	findContactKitIdentity: async () => ({ kitSubscriberId: null }),
}))
vi.mock('@/lib/subscriber-marketing/contact-profile-version-drizzle', () => ({
	createDrizzleContactProfileVersionStore: () => ({
		acknowledge: mocks.acknowledge,
	}),
}))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({
	captureDrovrOutboxLive: async () => ({ status: 'outboxed', inserted: 1 }),
	holdDrovrStopsLive: async () => 0,
	settleDrovrOutboxLive: mocks.settle,
}))
import { drovrContactSyncRetry } from './drovr-contact-sync-retry'
import type { DrovrContactSyncRetryRequested } from '@/inngest/events/drovr'
const fn = drovrContactSyncRetry as unknown as {
	handler: (args: {
		event: { data: DrovrContactSyncRetryRequested['data'] }
		step: ReturnType<typeof tools>
		attempt: number
		maxAttempts: number
	}) => Promise<unknown>
}
function tools() {
	return {
		run: async <T>(_id: string, action: () => Promise<T>) => action(),
		sleepUntil: vi.fn(async () => {}),
		sendEvent: vi.fn(async (_id: string, _value: unknown) => {}),
	}
}
function fact(
	type: DrovrShadowEvent['type'] = 'contact.profile.updated',
): DrovrShadowEvent {
	return {
		tenantId: 'org-aihero',
		contactId: 'contact',
		journeyId: 'contact-directory',
		type,
		occurredAt: '2026-10-01T00:00:00Z',
		idempotencyKey: `synthetic:${type}`,
		payload: {
			profileVersion: 1,
			email: 'learner@example.test',
			firstName: null,
			holds: [],
		},
	}
}
function request(
	event: DrovrShadowEvent,
	extra: Partial<DrovrContactSyncRetryRequested['data']> = {},
): DrovrContactSyncRetryRequested['data'] {
	return {
		items: [{ event, reason: 'event-not-live' }],
		attempt: 1,
		...extra,
	}
}
async function run(data: DrovrContactSyncRetryRequested['data']) {
	const step = tools()
	const result = await fn.handler({
		event: { data },
		step,
		attempt: 0,
		maxAttempts: 9,
	})
	return { step, result }
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
	mocks.deliver.mockImplementation(async ({ events }) => ({
		accepted: events.length,
		rejected: 0,
	}))
})
afterEach(() => {
	vi.unstubAllEnvs()
})
describe('the real straggler wrapper', () => {
	it('keeps a genuine coupon live, but reserves for a bump offer on its originating class', async () => {
		await run(request(fact('contact.offer.issued')))
		expect(mocks.reserve).not.toHaveBeenCalled()
		await run(request(fact('contact.offer.issued'), { paceClass: 'backfill' }))
		expect(mocks.reserve).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			'backfill',
		)
	})
	it('births once for eight cold links and charges every actual birth/retry POST', async () => {
		let born = false
		mocks.deliver.mockImplementation(async ({ events }) => {
			if (events[0]!.type === 'contact.created') {
				born = true
				return { accepted: 1, rejected: 0 }
			}
			return born
				? { accepted: events.length, rejected: 0 }
				: {
						accepted: 0,
						rejected: 0,
						deferred: events.map((event) => ({
							event,
							reason: 'cold-start-unhandled',
						})),
					}
		})
		const items = Array.from({ length: 8 }, (_, index) => ({
			event: {
				...fact('contact.links.issued'),
				idempotencyKey: `links:contact:slot-${index}:v1`,
			},
			reason: 'cold-start-unhandled' as const,
		}))
		await run({
			items,
			attempt: 1,
			paceClass: 'delta',
			acknowledge: { contactId: 'contact', profileVersion: 1 },
		})
		expect(
			mocks.deliver.mock.calls.filter(
				([args]) => args.events[0]!.type === 'contact.created',
			),
		).toHaveLength(1)
		expect(mocks.reserve).toHaveBeenCalledTimes(17)
		expect(mocks.acknowledge).toHaveBeenCalledOnce()
	})
	it('a refusal well beyond two hours is rescheduled unchanged, not discarded', async () => {
		const event = fact()
		mocks.deliver.mockResolvedValue({
			accepted: 0,
			rejected: 0,
			deferred: [{ event, reason: 'event-not-live' }],
		})
		const { step } = await run(
			request(event, { attempt: 48, paceClass: 'delta' }),
		)
		expect(step.sendEvent).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				data: expect.objectContaining({
					attempt: 49,
					items: [{ event, reason: 'event-not-live' }],
					paceClass: 'delta',
				}),
			}),
		)
		expect(mocks.acknowledge).not.toHaveBeenCalled()
	})
})
