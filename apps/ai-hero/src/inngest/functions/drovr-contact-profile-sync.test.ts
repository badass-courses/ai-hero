import { describe, expect, it, vi } from 'vitest'

import type { ContactProfileSnapshot } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

import { runContactProfileSync } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

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
		valuePathSlug?: string
		snapshot?: ContactProfileSnapshot | undefined
		delivered?: { accepted: number; rejected: number } | 'not-configured'
	} = {},
) {
	const order: string[] = []
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			order.push(id)
			return callback()
		}),
	}
	const readSnapshot = vi.fn(async () =>
		'snapshot' in overrides ? overrides.snapshot : snapshot,
	)
	const bump = vi.fn(async () => 4)
	const deliver = vi.fn(async () =>
		'delivered' in overrides
			? overrides.delivered!
			: { accepted: 1, rejected: 0 },
	)
	const ownedPath = vi.fn(async () => 'ai-hero-skills-workflow')
	const run = () =>
		runContactProfileSync({
			event: {
				data: {
					contactId: overrides.contactId ?? 'contact-1',
					reason: 'journey-entered',
					...('valuePathSlug' in overrides
						? overrides.valuePathSlug
							? { valuePathSlug: overrides.valuePathSlug }
							: {}
						: { valuePathSlug: 'ai-hero-skills-workflow' }),
				},
			},
			step,
			env: overrides.env ?? { AIH_DROVR_PROFILE_SYNC: 'true' },
			readSnapshot,
			bump,
			deliver,
			ownedPath,
		})
	return { run, step, readSnapshot, bump, deliver, ownedPath, order }
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
		expect(h.deliver).not.toHaveBeenCalled()
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
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('reads, bumps once, then delivers and answers sent only once drovr took it', async () => {
		const h = harness()
		await expect(h.run()).resolves.toEqual({
			status: 'sent',
			profileVersion: 4,
			links: 0,
			offers: 0,
			accepted: 1,
			rejected: 0,
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
		expect(h.deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				tenantId: 'org-aihero',
				journeyId: 'contact-directory',
				type: 'contact.profile.updated',
				idempotencyKey: 'profile:contact-1:4',
			}),
		])
	})

	it('reports drovr not configured, so the reconcile never counts it as pushed', async () => {
		const h = harness({ delivered: 'not-configured' })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'drovr-not-configured',
		})
	})

	it('issues the path drovr owns for the contact when the request names none', async () => {
		const h = harness({ valuePathSlug: undefined })
		await h.run()
		expect(h.ownedPath).toHaveBeenCalledWith('contact-1')
		expect(h.readSnapshot).toHaveBeenCalledWith({
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
		})
	})
})
