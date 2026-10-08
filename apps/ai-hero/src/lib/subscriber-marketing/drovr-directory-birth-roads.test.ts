import { beforeEach, expect, it, vi } from 'vitest'
import {
	deliverDrovrShadowEventsDirect,
	emitDrovrShadowEvents,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { postDrovrOutboxRow, type DrovrOutboxPostPorts } from './drovr-outbox-replay-post'
import { outboxEntryForEvent, type DrovrOutboxRow } from './drovr-outbox'

const mocks = vi.hoisted(() => ({ standing: vi.fn() }))
vi.mock('./drovr-directory-birth-standing-live', () => ({
	readDirectoryBirthStanding: mocks.standing,
}))
const birth: DrovrShadowEvent = {
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'contact-directory',
	type: 'contact.created',
	occurredAt: '2026-10-01T00:00:00Z',
	idempotencyKey: 'directory:seed:contact-1',
	payload: {
		lifecycle: 'provisional',
		createdAt: '2026-10-01T00:00:00Z',
		source: 'ai-hero',
		kitSubscriberId: '42',
	},
}
const config = {
	ingestUrl: 'https://drovr.test/events',
	authorityApiKey: 'test-key',
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.standing.mockResolvedValue(new Map([['contact-1', 'unsubscribed']]))
})

it.each(['emit', 'fallback'])(
	'the %s road posts a tagged directory birth as stopped',
	async (road) => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{}', { status: 200 }),
		)
		const options = { config, fetch: fetcher, info: vi.fn() }
		if (road === 'emit') await emitDrovrShadowEvents([birth], options)
		else
			expect(await deliverDrovrShadowEventsDirect([birth], options)).toEqual([])
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
			idempotencyKey: birth.idempotencyKey,
			payload: { lifecycle: 'unsubscribed' },
		})
	},
)

it('the outbox road posts a tagged directory birth as stopped, under its existing key', async () => {
	const at = '2026-10-02T00:00:00Z'
	const row: DrovrOutboxRow = {
		...outboxEntryForEvent(birth, 'fallback'),
		id: 'row-1',
		dedupeKey: 'row-key',
		target: 'org-aihero',
		status: 'pending',
		attempts: 0,
		lastStatus: null,
		lastError: null,
		firstFailedAt: at,
		nextAttemptAt: at,
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: at,
	}
	const deliver = vi.fn(async (_args: Parameters<DrovrOutboxPostPorts['deliver']>[0]) => ({ status: 'accepted' as const }))
	expect(
		await postDrovrOutboxRow(row, {
			ingestUrl: config.ingestUrl,
			readBirthOptOuts: vi.fn(),
			info: vi.fn(),
			apiKeyFor: () => config.authorityApiKey,
			deliver,
			fanOut: async (events) => [...events],
			isNeverBornOwnerStop: () => false,
		}),
	).toEqual({ kind: 'delivered', httpStatus: 200 })
	expect(deliver.mock.calls[0]?.[0]).toMatchObject({
		event: {
			idempotencyKey: birth.idempotencyKey,
			payload: { lifecycle: 'unsubscribed' },
		},
		clampAt: Date.parse(at),
	})
})

it('fallback standing failure throws before any post so dispatch can outbox it', async () => {
	mocks.standing.mockRejectedValue(new Error('Kit read unavailable'))
	const fetcher = vi.fn()
	await expect(
		deliverDrovrShadowEventsDirect([birth], { config, fetch: fetcher }),
	).rejects.toThrow('Kit read unavailable')
	expect(fetcher).not.toHaveBeenCalled()
})
