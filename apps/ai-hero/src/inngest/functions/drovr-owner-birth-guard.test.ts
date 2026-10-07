import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((config, trigger, handler) => ({
		config,
		trigger,
		handler,
	})),
	deliverOrThrow: vi.fn(async () => ({ status: 'accepted' })),
	runOwnerBirthGuard: vi.fn(),
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({
	env: { DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events' },
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
	readDrovrEmailDelivery: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/drovr-contact-actor', () => ({
	readDrovrContactActor: vi.fn(),
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

afterEach(() => vi.restoreAllMocks())

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
