import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((config, trigger, handler) => ({
		config,
		trigger,
		handler,
	})),
	deliverOrThrow: vi.fn(async () => ({ status: 'accepted' })),
	runOwnerBirthGuard: vi.fn(),
	readActor: vi.fn(),
	readDelivery: vi.fn(),
	prepareBirthFeed: vi.fn(),
	readBirths: vi.fn(),
	createFeedStore: vi.fn(() => ({})),
	env: {
		DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events',
		AIH_DROVR_BIRTH_FEED_ENABLED: '',
	},
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@/lib/subscriber-marketing/drovr-birth-feed', async () => {
	const { NonRetriableError } = await import('inngest')
	return {
		prepareBirthFeed: mocks.prepareBirthFeed,
		readDrovrBirths: mocks.readBirths,
		BirthFeedFailure: NonRetriableError,
	}
})
vi.mock('@/lib/subscriber-marketing/drovr-birth-feed-store', () => ({
	createRedisBirthFeedStore: mocks.createFeedStore,
}))
vi.mock('@/env.mjs', () => ({
	env: mocks.env,
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/owner-birth-guard-drizzle', () => ({
	createDrizzleOwnerBirthGuardStore: () => ({}),
	ownerBirthRepostMarker: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/owner-birth-guard', () => ({
	runOwnerBirthGuard: mocks.runOwnerBirthGuard,
}))
vi.mock('@/lib/subscriber-marketing/drovr-email-delivery', () => ({
	readDrovrEmailDelivery: mocks.readDelivery,
}))
vi.mock('@/lib/subscriber-marketing/drovr-contact-actor', () => ({
	readDrovrContactActor: mocks.readActor,
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({
	deliverOrThrow: mocks.deliverOrThrow,
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', () => ({
	DROVR_AUTHORITY_TENANT_ID: 'org-aihero',
	drovrApiKeyForTenant: () => 'authority-key',
}))
vi.mock('@/lib/subscriber-marketing/drovr-unsubscribe-page', () => ({
	resolveDrovrApiBaseUrl: () => 'https://drovr.test',
}))
vi.mock('@/lib/subscriber-marketing/skills-newsletter-path-entry', () => ({
	SKILLS_WORKFLOW_EMAIL_ZERO: 'email-zero',
}))

import { drovrOwnerBirthGuard } from './drovr-owner-birth-guard'

type Registered = {
	handler: (input: {
		step: {
			run: (id: string, operation: () => unknown) => unknown
			sleep?: (id: string, duration: string) => Promise<void>
		}
	}) => Promise<unknown>
}

afterEach(() => {
	vi.restoreAllMocks()
	mocks.env.AIH_DROVR_BIRTH_FEED_ENABLED = ''
})

describe('feed rollout boundary', () => {
	it.each(['', 'false', '1'])(
		'defaults to contact mode for flag=%s with no feed calls/store',
		async (flag) => {
			mocks.env.AIH_DROVR_BIRTH_FEED_ENABLED = flag
			mocks.prepareBirthFeed.mockClear()
			mocks.createFeedStore.mockClear()
			mocks.runOwnerBirthGuard.mockResolvedValue({ status: 'checked' })
			await (drovrOwnerBirthGuard as unknown as Registered).handler({
				step: { run: async (_id, op) => op() },
			})
			expect(mocks.prepareBirthFeed).not.toHaveBeenCalled()
			expect(mocks.createFeedStore).not.toHaveBeenCalled()
		},
	)
	it('only a fully prepared proof enters guard evaluation', async () => {
		mocks.env.AIH_DROVR_BIRTH_FEED_ENABLED = 'true'
		const proof = { judge: vi.fn() }
		mocks.prepareBirthFeed.mockResolvedValue({ kind: 'ready', calls: 3, proof })
		mocks.runOwnerBirthGuard.mockResolvedValue({
			status: 'checked',
			reposted: 0,
		})
		expect(
			await (drovrOwnerBirthGuard as unknown as Registered).handler({
				step: { run: async (_id, op) => op() },
			}),
		).toMatchObject({ birthFeedCalls: 3 })
		expect(mocks.runOwnerBirthGuard).toHaveBeenLastCalledWith(
			expect.objectContaining({
				ports: expect.objectContaining({ birthFeed: proof }),
			}),
		)
		expect(mocks.createFeedStore).toHaveBeenLastCalledWith(
			expect.objectContaining({ tenantId: 'org-aihero' }),
		)
	})
	it('shed feed stops before local scan and performs one bounded durable cooldown', async () => {
		mocks.env.AIH_DROVR_BIRTH_FEED_ENABLED = 'true'
		mocks.runOwnerBirthGuard.mockClear()
		mocks.prepareBirthFeed.mockResolvedValue({
			kind: 'shed',
			calls: 2,
			backpressure: { status: 503, retryAfter: '86400' },
		})
		const sleep = vi.fn(async () => {})
		expect(
			await (drovrOwnerBirthGuard as unknown as Registered).handler({
				step: { run: async (_id, op) => op(), sleep },
			}),
		).toMatchObject({ status: 'deferred', reposted: 0, birthFeedCalls: 2 })
		expect(sleep).toHaveBeenCalledWith('shed-read-cooldown', '3000000ms')
		expect(mocks.runOwnerBirthGuard).not.toHaveBeenCalled()
	})
	it('cap failure remains terminal and loud, never entering contact fallback', async () => {
		mocks.env.AIH_DROVR_BIRTH_FEED_ENABLED = 'true'
		mocks.runOwnerBirthGuard.mockClear()
		mocks.prepareBirthFeed.mockRejectedValue(new Error('page cap'))
		await expect(
			(drovrOwnerBirthGuard as unknown as Registered).handler({
				step: { run: async (_id, op) => op() },
			}),
		).rejects.toThrow('page cap')
		expect(mocks.runOwnerBirthGuard).not.toHaveBeenCalled()
		const { log } = await import('@/server/logger')
		expect(log.error).toHaveBeenCalledWith(
			'drovr.owner_birth_guard.feed_failed',
			expect.any(Object),
		)
	})
})

describe('the owner birth guard clamps a re-post at its run start (row 201g)', () => {
	it.each([
		{ status: 503, retryAfter: '7', duration: '7000ms' },
		{ status: 429, retryAfter: '3', duration: '3000ms' },
		{
			status: 503,
			retryAfter: 'Wed, 07 Oct 2026 15:00:15 GMT',
			duration: '15000ms',
		},
		{ status: 503, retryAfter: 'invalid', duration: '120000ms' },
		{ status: 504, retryAfter: '3600', duration: '3000000ms' },
		{ status: 503, retryAfter: '86400', duration: '3000000ms' },
		{
			status: 502,
			retryAfter: 'Thu, 08 Oct 2026 15:00:00 GMT',
			duration: '3000000ms',
		},
		{ status: 'timeout', retryAfter: undefined, duration: '120000ms' },
		{ status: 'page-budget', retryAfter: undefined, duration: '120000ms' },
	])(
		'stops without read retry and durably honors $status Retry-After=$retryAfter',
		async ({ status, retryAfter, duration }) => {
			vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-07T15:00:00Z'))
			mocks.runOwnerBirthGuard.mockResolvedValue({
				status: 'deferred',
				reposted: 0,
				backpressure: { status, retryAfter },
			})
			const step = {
				run: vi.fn(async (_id: string, operation: () => unknown) =>
					operation(),
				),
				sleep: vi.fn(async () => {}),
			}
			const result = await (
				drovrOwnerBirthGuard as unknown as Registered
			).handler({ step })
			expect(step.sleep).toHaveBeenCalledOnce()
			expect(step.sleep).toHaveBeenCalledWith('shed-read-cooldown', duration)
			expect(result).toMatchObject({
				status: 'deferred',
				reposted: 0,
				cooldownMs: parseInt(duration, 10),
			})
		},
	)

	it('registers singleton skip with concurrency one so overlapping cron ticks are dropped, not queued', () => {
		expect(drovrOwnerBirthGuard).toMatchObject({
			config: {
				concurrency: [{ limit: 1 }],
				singleton: { mode: 'skip' },
				timeouts: { finish: '55m' },
			},
			trigger: { cron: '40 * * * *' },
		})
	})

	it('forwards the remaining page timeout into both actual transport adapters', async () => {
		mocks.runOwnerBirthGuard.mockImplementation(
			async ({
				ports,
			}: {
				ports: {
					readActor: (
						id: string,
						journey: string,
						timeoutMs: number,
					) => Promise<unknown>
					readDelivery: (id: string, timeoutMs: number) => Promise<unknown>
				}
			}) => {
				await ports.readActor('c1', 'journey', 1_500)
				await ports.readDelivery('c1', 900)
				return { status: 'checked' }
			},
		)
		await (drovrOwnerBirthGuard as unknown as Registered).handler({
			step: { run: async (_id, operation) => operation() },
		})
		expect(mocks.readActor).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 1_500 }),
		)
		expect(mocks.readDelivery).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 900 }),
		)
	})

	it("posts every re-post with the memoized start, so a retry of the re-post's step sends the same bytes", async () => {
		const STARTED = Date.parse('2026-09-30T12:40:00.000Z')
		// Inngest returns the memoized start on every attempt of the run.
		const step = {
			run: vi.fn(async (id: string, operation: () => unknown) =>
				id === 'started-at' ? STARTED : operation(),
			),
		}
		mocks.runOwnerBirthGuard.mockImplementation(
			async ({
				ports,
			}: {
				ports: { post: (event: unknown) => Promise<unknown> }
			}) => {
				await ports.post({ idempotencyKey: 'owner:birth:1' })
				await ports.post({ idempotencyKey: 'owner:birth:1' })
			},
		)
		await (drovrOwnerBirthGuard as unknown as Registered).handler({ step })
		expect(mocks.deliverOrThrow).toHaveBeenCalledTimes(2)
		for (const [args] of mocks.deliverOrThrow.mock.calls as unknown as [
			{ clampAt: number },
		][])
			expect(args.clampAt).toBe(STARTED)
	})
})
