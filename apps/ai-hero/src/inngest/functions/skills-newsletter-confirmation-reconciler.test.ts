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
vi.mock(
	'@/lib/subscriber-marketing/signup-confirmation-reconciler.server',
	() => ({ buildSignupConfirmationReconciliationBatch: vi.fn() }),
)

const { skillsNewsletterConfirmationReconciler } =
	await import('./skills-newsletter-confirmation-reconciler')

type Registered = {
	config: { id: string; concurrency: unknown }
	trigger: { cron: string }
}
const registered =
	skillsNewsletterConfirmationReconciler as unknown as Registered

const minutesOf = (cron: string) =>
	cron
		.split(' ')[0]!
		.split(',')
		.map((minute) => Number(minute))

describe('skills newsletter confirmation reconciler registration', () => {
	it('runs every 15 minutes, so a confirmation waits at most one quarter, not an hour', () => {
		const minutes = minutesOf(registered.trigger.cron)
		expect(registered.trigger.cron.split(' ').slice(1)).toEqual([
			'*',
			'*',
			'*',
			'*',
		])
		expect(minutes).toHaveLength(4)
		const sorted = [...minutes].sort((a, b) => a - b)
		expect(
			sorted.map(
				(minute, index) => (sorted[(index + 1) % 4]! - minute + 60) % 60,
			),
		).toEqual([15, 15, 15, 15])
	})

	it('stays off the quarter hours and :40, where the contact-sync reconcile and the birth guard run', () => {
		for (const minute of minutesOf(registered.trigger.cron)) {
			expect(minute % 15).not.toBe(0)
			expect(minute % 5).not.toBe(0)
		}
	})

	it('never overlaps itself: one run at a time', () => {
		expect(registered.config).toMatchObject({
			id: 'skills-newsletter-confirmation-reconciler',
			concurrency: 1,
		})
	})
})
