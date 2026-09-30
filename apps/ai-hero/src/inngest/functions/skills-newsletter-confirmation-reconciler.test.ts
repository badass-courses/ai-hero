import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
const reconcile = vi.hoisted(() => vi.fn())
vi.mock(
	'@/lib/subscriber-marketing/signup-confirmation-reconciler.server',
	() => ({ reconcileSkillsConfirmations: reconcile }),
)

const {
	SKILLS_CONFIRMATION_DAILY_CRON,
	SKILLS_CONFIRMATION_POLL_CRON,
	skillsConfirmationTierOf,
	skillsNewsletterConfirmationReconciler,
} = await import('./skills-newsletter-confirmation-reconciler')

type Registered = {
	config: { id: string; concurrency: unknown }
	trigger: Array<{ cron: string }>
	handler: (context: unknown) => Promise<unknown>
}
const registered =
	skillsNewsletterConfirmationReconciler as unknown as Registered
const poll = { cron: SKILLS_CONFIRMATION_POLL_CRON }

const minutesOf = (cron: string) =>
	cron
		.split(' ')[0]!
		.split(',')
		.map((minute) => Number(minute))

describe('skills newsletter confirmation reconciler registration', () => {
	it('runs every 15 minutes, so a confirmation waits at most one quarter, not an hour', () => {
		expect(registered.trigger).toContainEqual(poll)
		const minutes = minutesOf(poll.cron)
		expect(poll.cron.split(' ').slice(1)).toEqual(['*', '*', '*', '*'])
		expect(minutes).toHaveLength(4)
		const sorted = [...minutes].sort((a, b) => a - b)
		expect(
			sorted.map(
				(minute, index) => (sorted[(index + 1) % 4]! - minute + 60) % 60,
			),
		).toEqual([15, 15, 15, 15])
	})

	it('stays off the quarter hours and :40, where the contact-sync reconcile and the birth guard run', () => {
		for (const { cron } of registered.trigger)
			for (const minute of minutesOf(cron)) {
				expect(minute % 15).not.toBe(0)
				expect(minute % 5).not.toBe(0)
			}
	})

	it('scans every signup since the floor once a day, and the last 14 days on every poll (row 211)', () => {
		expect(registered.trigger).toEqual([
			poll,
			{ cron: SKILLS_CONFIRMATION_DAILY_CRON },
		])
		expect(SKILLS_CONFIRMATION_DAILY_CRON.split(' ').slice(2)).toEqual([
			'*',
			'*',
			'*',
		])
		expect(
			skillsConfirmationTierOf({
				data: { cron: SKILLS_CONFIRMATION_DAILY_CRON },
			}),
		).toBe('daily')
		expect(skillsConfirmationTierOf({ data: poll })).toBe('recent')
		// Anything else (an invoke, a manual run) scans the recent tier.
		expect(skillsConfirmationTierOf({})).toBe('recent')
	})

	it('never overlaps itself: one run at a time', () => {
		expect(registered.config).toMatchObject({
			id: 'skills-newsletter-confirmation-reconciler',
			concurrency: 1,
		})
	})
})

describe('the daily tier’s leftovers are loud (row 211 round 2, option d)', () => {
	const runWith = async (tier: 'daily' | 'recent', deferred: number) => {
		reconcile.mockResolvedValueOnce({
			tier,
			counts: {
				deferred,
				deferredBySliceLimit: deferred,
				deferredByCheckCap: 0,
				deferredBySendLimit: 0,
				tagChecked: 100,
				notInKit: 100,
				tagFailed: 0,
				planned: 0,
			},
			kit: { calls: 105, throttled: 0 },
		})
		const logger = { info: vi.fn(), warn: vi.fn() }
		await registered.handler({
			event: {
				data: {
					cron:
						tier === 'daily'
							? SKILLS_CONFIRMATION_DAILY_CRON
							: SKILLS_CONFIRMATION_POLL_CRON,
				},
			},
			step: { run: async (_: string, work: () => unknown) => work() },
			logger,
		})
		return logger.warn.mock.calls.map(([name, fields]) => [name, fields])
	}

	it('warns when a daily run leaves anyone deferred', async () => {
		expect(await runWith('daily', 5)).toEqual([
			[
				'subscriber_funnel.confirmation_daily_deferred',
				expect.objectContaining({
					deferred: 5,
					deferredBySliceLimit: 5,
					deferredByCheckCap: 0,
					deferredBySendLimit: 0,
				}),
			],
		])
	})

	it('stays quiet for a daily run with nobody left, and for any recent run', async () => {
		expect(await runWith('daily', 0)).toEqual([])
		expect(await runWith('recent', 5)).toEqual([])
	})
})
