import { describe, expect, it, vi } from 'vitest'

import { DROVR_EVENTS_DELIVER_EVENT } from '@/inngest/events/drovr'
import type { ContactProfileSnapshot } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: vi.fn(() => ({})) },
}))

const { runContactProfileSync } = await import('./drovr-contact-profile-sync')

const snapshot: ContactProfileSnapshot = {
	occurredAt: '2026-09-26T17:00:00.000Z',
	profile: { email: 'learner@example.test', firstName: 'Ada', holds: [] },
	links: [],
	offers: [],
}

function harness(
	overrides: {
		env?: Record<string, string>
		contactId?: string
		snapshot?: ContactProfileSnapshot | undefined
	} = {},
) {
	const order: string[] = []
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			order.push(id)
			return callback()
		}),
		sendEvent: vi.fn(async (id: string) => {
			order.push(id)
			return undefined
		}),
	}
	const readSnapshot = vi.fn(async () =>
		'snapshot' in overrides ? overrides.snapshot : snapshot,
	)
	const bump = vi.fn(async () => 4)
	const run = () =>
		runContactProfileSync({
			event: {
				data: {
					contactId: overrides.contactId ?? 'contact-1',
					reason: 'journey-entered',
					valuePathSlug: 'ai-hero-skills-workflow',
				},
			},
			step,
			env: overrides.env ?? { AIH_DROVR_PROFILE_SYNC: 'true' },
			readSnapshot,
			bump,
		})
	return { run, step, readSnapshot, bump, order }
}

describe('drovr contact profile sync function', () => {
	it('does nothing at all while the flag is off', async () => {
		const h = harness({ env: {} })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		expect(h.readSnapshot).not.toHaveBeenCalled()
		expect(h.step.run).not.toHaveBeenCalled()
		expect(h.step.sendEvent).not.toHaveBeenCalled()
	})

	it('never profiles a synthetic test principal', async () => {
		const h = harness({ contactId: 'synthetic_abc' })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'synthetic-principal',
		})
		expect(h.readSnapshot).not.toHaveBeenCalled()
	})

	it('spends no version on a contact ai-hero does not have', async () => {
		const h = harness({ snapshot: undefined })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'contact-missing',
		})
		expect(h.bump).not.toHaveBeenCalled()
		expect(h.step.sendEvent).not.toHaveBeenCalled()
	})

	it('reads, then bumps once, then hands the events to the live delivery lane', async () => {
		const h = harness()
		await expect(h.run()).resolves.toEqual({
			status: 'sent',
			profileVersion: 4,
			links: 0,
			offers: 0,
		})
		expect(h.order).toEqual([
			'read-profile',
			'bump-profile-version',
			'deliver-profile',
		])
		expect(h.readSnapshot).toHaveBeenCalledWith({
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
		})
		expect(h.bump).toHaveBeenCalledTimes(1)
		expect(h.step.sendEvent).toHaveBeenCalledWith('deliver-profile', {
			name: DROVR_EVENTS_DELIVER_EVENT,
			data: {
				source: 'contact-profile-sync',
				events: [
					expect.objectContaining({
						tenantId: 'org-aihero',
						journeyId: 'contact-directory',
						type: 'contact.profile.updated',
						idempotencyKey: 'profile:contact-1:4',
					}),
				],
			},
		})
	})
})
