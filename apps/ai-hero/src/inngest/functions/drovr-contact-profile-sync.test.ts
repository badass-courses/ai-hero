import { describe, expect, it, vi } from 'vitest'

import type { ContactProfileSnapshot } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'

import { contactSyncRetryRequest } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import {
	contactProfileContentHash,
	runContactProfileSync,
} from '@/lib/subscriber-marketing/drovr-contact-profile-sync'
import type { DeferredDrovrEvent } from '@/lib/subscriber-marketing/drovr-shadow-delivery'

const now = Date.parse('2026-09-27T12:00:00.000Z')

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
		delivered?:
			| {
					accepted: number
					rejected: number
					deferred?: DeferredDrovrEvent[]
			  }
			| 'not-configured'
		onSendingJourney?: boolean
	} = {},
) {
	const order: string[] = []
	const sent: { id: string; payload: unknown }[] = []
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			order.push(id)
			return callback()
		}),
		sendEvent: vi.fn(async (id: string, payload: unknown) => {
			order.push(id)
			sent.push({ id, payload })
		}),
	}
	const readSnapshot = vi.fn(async () =>
		'snapshot' in overrides ? overrides.snapshot : snapshot,
	)
	const versionFor = vi.fn(async () => ({
		profileVersion: 4,
		since: '2026-09-26T16:00:00.000Z',
	}))
	const deliver = vi.fn(async () =>
		'delivered' in overrides
			? overrides.delivered!
			: { accepted: 1, rejected: 0 },
	)
	const ownedPath = vi.fn(async () => 'ai-hero-skills-workflow')
	const onSendingJourney = vi.fn(async () => overrides.onSendingJourney ?? true)
	const birth = vi.fn(async () => {})
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
			versionFor,
			deliver,
			ownedPath,
			onSendingJourney,
			now: () => now,
			birth,
		})
	return {
		sent,
		birth,
		run,
		step,
		readSnapshot,
		versionFor,
		deliver,
		ownedPath,
		onSendingJourney,
		order,
	}
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

	it('pushes nothing for a contact on no drovr sending journey (drovr would refuse it)', async () => {
		// The contract: profile, links and offer events only for contacts
		// with a drovr sending journey; drovr migrates only those to v2.
		const h = harness({ onSendingJourney: false })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'no-sending-journey',
		})
		expect(h.onSendingJourney).toHaveBeenCalledWith('contact-1')
		expect(h.order).toEqual(['sending-journey'])
		expect(h.readSnapshot).not.toHaveBeenCalled()
		expect(h.versionFor).not.toHaveBeenCalled()
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('refused as event-not-live: schedules the same events for after the straggler pass, and answers deferred', async () => {
		// Contract §4: nothing was recorded and the key is unconsumed, so the
		// same event is retried unchanged; §3: it does not hold the watermark.
		const profileEvent = {
			tenantId: 'org-aihero' as const,
			contactId: 'contact-1',
			journeyId: 'contact-directory' as const,
			type: 'contact.profile.updated' as const,
			occurredAt: '2026-09-26T16:00:00.000Z',
			idempotencyKey: 'profile:contact-1:4',
		}
		const deferred: DeferredDrovrEvent[] = [
			{ event: profileEvent, reason: 'event-not-live' },
		]
		const h = harness({ delivered: { accepted: 0, rejected: 0, deferred } })
		await expect(h.run()).resolves.toEqual({
			status: 'deferred',
			reason: 'event-not-live',
			profileVersion: 4,
			deferred: 1,
		})
		expect(h.sent).toEqual([
			{
				id: 'defer-refused',
				payload: contactSyncRetryRequest(deferred, 1, now),
			},
		])
		// That actor exists, it is on v1: never a birth.
		expect(h.birth).not.toHaveBeenCalled()
	})

	it('refused as cold-start-unhandled: births the directory actor, then pushes again and answers sent', async () => {
		const profileEvent = {
			tenantId: 'org-aihero' as const,
			contactId: 'contact-1',
			journeyId: 'contact-directory' as const,
			type: 'contact.profile.updated' as const,
			occurredAt: '2026-09-26T16:00:00.000Z',
			idempotencyKey: 'profile:contact-1:4',
		}
		const cold: DeferredDrovrEvent[] = [
			{ event: profileEvent, reason: 'cold-start-unhandled' },
		]
		const h = harness()
		h.deliver
			.mockResolvedValueOnce({ accepted: 0, rejected: 0, deferred: cold })
			.mockResolvedValueOnce({ accepted: 1, rejected: 0 })
		await expect(h.run()).resolves.toMatchObject({
			status: 'sent',
			profileVersion: 4,
			accepted: 1,
		})
		expect(h.birth).toHaveBeenCalledWith(['contact-1'])
		expect(h.deliver).toHaveBeenNthCalledWith(2, [profileEvent])
		expect(h.order.slice(-3)).toEqual([
			'deliver-profile',
			'birth-directory',
			'redeliver-after-birth',
		])
		expect(h.sent).toEqual([])
	})

	it('pushes nothing for a contact with no email (drovr would ignore it as malformed)', async () => {
		// Contract §2 wants a non-empty email; with no profile drovr falls
		// back to live personalize, which holds the contact.
		const h = harness({
			snapshot: {
				...snapshot,
				profile: {
					email: '',
					firstName: null,
					holds: ['contact-email-missing'],
				},
			},
		})
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'contact-email-missing',
		})
		expect(h.versionFor).not.toHaveBeenCalled()
		expect(h.deliver).not.toHaveBeenCalled()
	})

	it('spends no version on a contact ai-hero does not have', async () => {
		const h = harness({ snapshot: undefined })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'contact-missing',
		})
		expect(h.versionFor).not.toHaveBeenCalled()
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
			'sending-journey',
			'read-profile',
			'profile-version',
			'deliver-profile',
		])
		expect(h.readSnapshot).toHaveBeenCalledWith({
			contactId: 'contact-1',
			valuePathSlug: 'ai-hero-skills-workflow',
		})
		expect(h.versionFor).toHaveBeenCalledTimes(1)
		expect(h.deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				tenantId: 'org-aihero',
				journeyId: 'contact-directory',
				type: 'contact.profile.updated',
				idempotencyKey: 'profile:contact-1:4',
			}),
		])
	})

	it('versions by content: the hash covers what drovr stores, and every event carries when that version was set', async () => {
		const h = harness()
		await h.run()
		expect(h.versionFor).toHaveBeenCalledWith(
			'contact-1',
			contactProfileContentHash(snapshot),
		)
		expect(h.deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				idempotencyKey: 'profile:contact-1:4',
				occurredAt: '2026-09-26T16:00:00.000Z',
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

	it('reports a rejection, so the reconcile never counts a refused profile as pushed', async () => {
		const h = harness({ delivered: { accepted: 2, rejected: 1 } })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'drovr-rejected',
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
