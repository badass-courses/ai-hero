import { describe, expect, it, vi } from 'vitest'

import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'

import { requestContactProfileSync } from './drovr-contact-profile-sync'
import { createKitSubscriberLinker } from './drovr-list-subscribe'

const on = { AIH_DROVR_PROFILE_SYNC: 'true' }

describe('awaited profile sync requests (writers without a scanned ContactEvent)', () => {
	it('is off with the flag, sends once when on, and reports a failure loudly without throwing', async () => {
		const send = vi.fn(async () => undefined)
		const error = vi.fn()
		await expect(
			requestContactProfileSync(
				{ contactId: 'c1', reason: 'kit-identity-linked' },
				{ env: {}, send, error },
			),
		).resolves.toBe('off')
		expect(send).not.toHaveBeenCalled()

		await expect(
			requestContactProfileSync(
				{ contactId: 'c1', reason: 'kit-identity-linked' },
				{ env: on, send, error },
			),
		).resolves.toBe('requested')
		expect(send).toHaveBeenCalledWith({
			name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
			data: { contactId: 'c1', reason: 'kit-identity-linked' },
		})

		await expect(
			requestContactProfileSync(
				{ contactId: 'c1', reason: 'kit-identity-linked' },
				{
					env: on,
					send: async () => {
						throw new Error('inngest down')
					},
					error,
				},
			),
		).resolves.toBe('failed')
		expect(error).toHaveBeenCalledWith(
			'drovr.profile_sync.request_failed',
			expect.objectContaining({
				contactId: 'c1',
				reason: 'kit-identity-linked',
				error: 'inngest down',
			}),
		)
	})
})

describe('linking a contact to its first Kit subscriber', () => {
	function linker(
		existing: { owner?: string; contactKitId?: string } = {},
		sync: 'requested' | 'failed' = 'requested',
	) {
		const order: string[] = []
		const requestSync = vi.fn(async () => {
			order.push('sync')
			return sync
		})
		let linked: { id: string; contactId: string } | undefined
		const createProviderIdentity = vi.fn(
			async (input: { contactId: string }) => {
				linked = { id: 'identity-9', contactId: input.contactId }
			},
		)
		const createContactEvent = vi.fn(async (input: unknown) => {
			order.push('event')
			return input
		})
		const link = createKitSubscriberLinker({
			repository: {
				findProviderIdentity: async () =>
					existing.owner
						? { id: 'identity-x', contactId: existing.owner }
						: linked,
				findKitSubscriberIdForContact: async () => existing.contactKitId,
				createProviderIdentity,
				createContactEvent,
			},
			requestSync,
			info: vi.fn(),
			warn: vi.fn(),
			now: () => '2026-09-26T18:00:00.000Z',
		})
		return {
			link,
			requestSync,
			createProviderIdentity,
			createContactEvent,
			order,
		}
	}

	it('records the link as a ContactEvent the reconcile scans, before asking for the sync', async () => {
		const l = linker({}, 'failed')
		await l.link('c1', 'kit-9')
		// Durable: even with the request failed, the scan picks the contact up.
		expect(l.order).toEqual(['event', 'sync'])
		expect(l.createContactEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				contactId: 'c1',
				providerIdentityId: 'identity-9',
				eventType: 'kit-identity.linked',
				occurredAt: '2026-09-26T18:00:00.000Z',
				semanticIdempotencyKey: expect.stringContaining('kit-9'),
			}),
		)
	})

	it('asks for a profile sync when it links: the answer links now sign a new subscriber id', async () => {
		const l = linker()
		await l.link('c1', 'kit-9')
		expect(l.createProviderIdentity).toHaveBeenCalledTimes(1)
		expect(l.requestSync).toHaveBeenCalledWith({
			contactId: 'c1',
			reason: 'kit-identity-linked',
		})
	})

	it('asks for nothing when nothing was linked', async () => {
		for (const existing of [
			{ owner: 'c1' },
			{ owner: 'c2' },
			{ contactKitId: 'kit-1' },
		]) {
			const l = linker(existing)
			await l.link('c1', 'kit-9')
			expect(l.requestSync).not.toHaveBeenCalled()
			expect(l.createContactEvent).not.toHaveBeenCalled()
		}
	})
})
