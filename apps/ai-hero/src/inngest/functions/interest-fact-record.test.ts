import { beforeEach, describe, expect, it, vi } from 'vitest'

import { pendingInterestKey } from '@/lib/cta/interest-fact-pending'
import {
	INTEREST_CHECK_OFFSETS_MS,
	INTEREST_CONFIRM_WINDOW_MS,
} from '@/lib/cta/interest-fact-recorder'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
	findContactIdForEmail: vi.fn(),
	writeLocalInterestFact: vi.fn(),
	resolve: vi.fn(),
	recordInterestFacts: vi.fn(),
	redisRows: new Map<string, unknown>(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/cta/interest-fact-store', () => ({
	findContactIdForEmail: (_db: unknown, email: string) =>
		mocks.findContactIdForEmail(email),
	writeLocalInterestFact: (_db: unknown, args: unknown) =>
		mocks.writeLocalInterestFact(args),
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', () => ({
	drovrApiKeyForTenant: () => 'key',
}))
vi.mock('@/lib/subscriber-marketing/drovr-unsubscribe-page', () => ({
	resolveDrovrApiBaseUrl: () => 'https://drovr.test',
}))
vi.mock('@/lib/subscriber-marketing/drovr-purchase-resolve', () => ({
	normalizeResolveEmail: (email: string) => email.trim().toLowerCase(),
	resolveDrovrContacts: async ({ emails }: { emails: string[] }) =>
		new Map([[emails[0]!.toLowerCase(), await mocks.resolve(emails[0])]]),
}))
vi.mock('@/lib/subscriber-marketing/survey-interest-facts-live', () => ({
	recordInterestFacts: mocks.recordInterestFacts,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/redis-client', () => ({
	redis: {
		get: async (key: string) => mocks.redisRows.get(key) ?? null,
		set: async (key: string, value: unknown, options: { nx?: true }) => {
			if (options.nx && mocks.redisRows.has(key)) return null
			mocks.redisRows.set(key, value)
			return 'OK'
		},
		del: async (key: string) => mocks.redisRows.delete(key),
	},
}))

const { interestFactRecord } = await import('./interest-fact-record')
const handler = (interestFactRecord as any).handler as (ctx: unknown) => any

const receivedAt = Date.parse('2026-10-29T21:07:00.000Z')
const data = {
	email: 'new-reader@example.test',
	fieldKey: 'waitlist_claude_code_for_real_engineers_cohort_3',
	expressedAt: '2026-10-29T21:07:00.000Z',
	via: 'form' as const,
}
const pendingKey = pendingInterestKey(data.email, data.fieldKey)

/** Runs steps inline, like Inngest with every step fresh, and logs the plan. */
function fakeStep() {
	const ran: string[] = []
	const sleeps: { id: string; at: Date }[] = []
	return {
		ran,
		sleeps,
		step: {
			run: async (id: string, fn: () => unknown) => {
				ran.push(id)
				return JSON.parse(JSON.stringify((await fn()) ?? null))
			},
			sleepUntil: async (id: string, at: Date) => {
				sleeps.push({ id, at })
			},
		},
	}
}

/** The person is unknown until the nth look (1 is the first look). */
function knownFromLook(look: number, onLook?: (n: number) => void) {
	let looks = 0
	mocks.findContactIdForEmail.mockImplementation(async () => {
		looks += 1
		onLook?.(looks)
		return looks >= look ? 'local-1' : undefined
	})
	mocks.resolve.mockImplementation(async () =>
		looks >= look
			? { status: 'resolved', contactId: 'drovr-1' }
			: { status: 'missing' },
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.redisRows.clear()
	mocks.writeLocalInterestFact.mockImplementation(
		async (args: { at: string }) => ({
			status: 'inserted',
			occurredAt: args.at,
		}),
	)
	mocks.recordInterestFacts.mockResolvedValue(undefined)
})

describe('interest-fact-record', () => {
	it('a known person records at once and holds nothing after', async () => {
		knownFromLook(1)
		const { step, sleeps } = fakeStep()
		expect(await handler({ event: { data, ts: receivedAt }, step })).toEqual({
			local: 'inserted',
			drovr: 'recorded',
			wait: 'none',
			checks: 1,
		})
		expect(sleeps).toEqual([])
		expect(mocks.redisRows.size).toBe(0)
	})

	it('holds an unconfirmed join, then attaches it to the contact on confirm at its first time', async () => {
		let heldDuringWait: unknown
		knownFromLook(4, (n) => {
			if (n === 2) heldDuringWait = mocks.redisRows.get(pendingKey)
		})
		const { step, sleeps, ran } = fakeStep()

		const output = await handler({ event: { data, ts: receivedAt }, step })

		expect(heldDuringWait).toEqual({ at: data.expressedAt })
		expect(output).toEqual({
			local: 'inserted',
			drovr: 'recorded',
			wait: 'attached',
			checks: 4,
		})
		// The first wait keeps the old step ids, so in-flight runs carry on.
		expect(sleeps.map((s) => s.id)).toEqual([
			'wait-for-signup',
			'wait-for-confirm-1',
			'wait-for-confirm-2',
		])
		expect(sleeps.map((s) => s.at.getTime() - receivedAt)).toEqual(
			INTEREST_CHECK_OFFSETS_MS.slice(0, 3),
		)
		expect(mocks.writeLocalInterestFact).toHaveBeenCalledOnce()
		expect(mocks.writeLocalInterestFact).toHaveBeenCalledWith({
			contactId: 'local-1',
			fieldKey: data.fieldKey,
			at: data.expressedAt,
		})
		expect(mocks.recordInterestFacts).toHaveBeenCalledOnce()
		expect(mocks.recordInterestFacts).toHaveBeenCalledWith({
			facts: [
				expect.objectContaining({
					contactId: 'drovr-1',
					at: data.expressedAt,
					role: data.fieldKey,
				}),
			],
			config: { baseUrl: 'https://drovr.test', apiKey: 'key' },
			firstWins: true,
		})
		expect(ran).toContain('release-pending-join')
		expect(mocks.redisRows.has(pendingKey)).toBe(false)
		expect(mocks.log.info).toHaveBeenCalledWith('interest.fact.recorded', {
			fieldKey: data.fieldKey,
			via: 'form',
			local: 'inserted',
			drovr: 'recorded',
			wait: 'attached',
			checks: 4,
		})
	})

	it('keeps waiting while the local contact exists but drovr has not resolved it', async () => {
		mocks.findContactIdForEmail.mockResolvedValue('local-1')
		let looks = 0
		mocks.resolve.mockImplementation(async () =>
			++looks >= 3
				? { status: 'resolved', contactId: 'drovr-1' }
				: { status: 'missing' },
		)
		const { step } = fakeStep()
		expect(
			await handler({ event: { data, ts: receivedAt }, step }),
		).toMatchObject({ drovr: 'recorded', wait: 'attached', checks: 3 })
		expect(mocks.recordInterestFacts).toHaveBeenCalledOnce()
	})

	it('ends cleanly at 7 days, logging expired, with nothing recorded', async () => {
		knownFromLook(Number.POSITIVE_INFINITY)
		const { step, sleeps } = fakeStep()

		const output = await handler({ event: { data, ts: receivedAt }, step })

		expect(output).toEqual({
			local: 'no-contact',
			drovr: 'unresolved',
			wait: 'expired',
			checks: INTEREST_CHECK_OFFSETS_MS.length + 1,
		})
		expect(sleeps.at(-1)!.at.getTime()).toBe(
			receivedAt + INTEREST_CONFIRM_WINDOW_MS,
		)
		expect(
			sleeps.every(
				(s) => s.at.getTime() <= receivedAt + INTEREST_CONFIRM_WINDOW_MS,
			),
		).toBe(true)
		expect(mocks.writeLocalInterestFact).not.toHaveBeenCalled()
		expect(mocks.recordInterestFacts).not.toHaveBeenCalled()
		expect(mocks.redisRows.has(pendingKey)).toBe(false)
		expect(mocks.log.info).toHaveBeenCalledWith(
			'interest.fact.recorded',
			expect.objectContaining({ wait: 'expired' }),
		)
	})

	it('measures the window from arrival, not a backfill’s older join date', async () => {
		knownFromLook(Number.POSITIVE_INFINITY)
		const { step, sleeps } = fakeStep()
		await handler({
			event: {
				data: { ...data, expressedAt: '2026-09-01T00:00:00.000Z' },
				ts: receivedAt,
			},
			step,
		})
		expect(sleeps.at(-1)!.at.getTime()).toBe(
			receivedAt + INTEREST_CONFIRM_WINDOW_MS,
		)
	})

	it('a duplicate join after the idempotency window records the first join time once', async () => {
		// The first run is still waiting and holds the earlier time.
		const first = '2026-10-29T21:07:00.000Z'
		mocks.redisRows.set(pendingKey, { at: first })
		const local = new Map<string, string>()
		mocks.writeLocalInterestFact.mockImplementation(
			async (args: { at: string }) => {
				const existing = local.get('local-1')
				if (existing) return { status: 'existing', occurredAt: existing }
				local.set('local-1', args.at)
				return { status: 'inserted', occurredAt: args.at }
			},
		)
		knownFromLook(1)

		const second = { ...data, expressedAt: '2026-10-31T08:00:00.000Z' }
		const a = await handler({
			event: { data: second, ts: Date.parse(second.expressedAt) },
			step: fakeStep().step,
		})
		const b = await handler({
			event: { data: second, ts: Date.parse(second.expressedAt) },
			step: fakeStep().step,
		})

		expect(a).toMatchObject({ local: 'inserted', drovr: 'recorded' })
		expect(b).toMatchObject({ local: 'existing', drovr: 'recorded' })
		expect(local.get('local-1')).toBe(first)
		// Both drovr facts carry the same source id and time; firstWins keeps one.
		const facts = mocks.recordInterestFacts.mock.calls.map(
			([args]) => args.facts[0],
		)
		expect(new Set(facts.map((f: any) => f.sourceId)).size).toBe(1)
		expect(facts.every((f: any) => f.at === first)).toBe(true)
		expect(
			mocks.recordInterestFacts.mock.calls.every(([args]) => args.firstWins),
		).toBe(true)
	})

	it('a Redis failure never costs the join', async () => {
		knownFromLook(1)
		const redis = (await import('@/server/redis-client')).redis as any
		const get = redis.get
		redis.get = async () => {
			throw new Error('upstash down')
		}
		try {
			const { step } = fakeStep()
			expect(
				await handler({ event: { data, ts: receivedAt }, step }),
			).toMatchObject({ local: 'inserted', drovr: 'recorded' })
			expect(mocks.log.warn).toHaveBeenCalledWith(
				'interest.fact.pending.hold_failed',
				expect.objectContaining({ fieldKey: data.fieldKey }),
			)
		} finally {
			redis.get = get
		}
	})

	it('keeps the function idempotent on email and list', () => {
		expect((interestFactRecord as any).config.idempotency).toBe(
			'event.data.email + ":" + event.data.fieldKey',
		)
	})
})
