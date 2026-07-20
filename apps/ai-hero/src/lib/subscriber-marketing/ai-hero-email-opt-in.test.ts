import { describe, expect, it, vi } from 'vitest'

import {
	AI_HERO_UNSUBSCRIBED_TAG_ID,
	reconcileAiHeroEmailOptIn,
} from './ai-hero-email-opt-in'

describe('reconcileAiHeroEmailOptIn', () => {
	it('requires confirmation before changing an inactive subscriber', async () => {
		const getSubscriberByEmail = vi.fn()
		const removeUnsubscribeTag = vi.fn()

		await expect(
			reconcileAiHeroEmailOptIn({
				email: 'person@example.com',
				subscriberState: 'inactive',
				getSubscriberByEmail,
				removeUnsubscribeTag,
			}),
		).resolves.toEqual({ status: 'confirmation-required' })
		expect(getSubscriberByEmail).not.toHaveBeenCalled()
		expect(removeUnsubscribeTag).not.toHaveBeenCalled()
	})

	it('keeps an active subscriber unchanged when the unsubscribe tag is absent', async () => {
		const getSubscriberByEmail = vi.fn().mockResolvedValue({
			state: 'active',
			tags: [],
		})
		const removeUnsubscribeTag = vi.fn()

		await expect(
			reconcileAiHeroEmailOptIn({
				email: 'person@example.com',
				subscriberState: 'active',
				getSubscriberByEmail,
				removeUnsubscribeTag,
			}),
		).resolves.toEqual({
			status: 'active',
			removedUnsubscribeTag: false,
		})
		expect(removeUnsubscribeTag).not.toHaveBeenCalled()
	})

	it('removes and verifies the stale unsubscribe tag after explicit opt-in', async () => {
		const getSubscriberByEmail = vi
			.fn()
			.mockResolvedValueOnce({
				state: 'active',
				tags: [{ id: AI_HERO_UNSUBSCRIBED_TAG_ID }],
			})
			.mockResolvedValueOnce({ state: 'active', tags: [] })
		const removeUnsubscribeTag = vi.fn().mockResolvedValue(undefined)

		await expect(
			reconcileAiHeroEmailOptIn({
				email: 'person@example.com',
				subscriberState: 'active',
				getSubscriberByEmail,
				removeUnsubscribeTag,
			}),
		).resolves.toEqual({
			status: 'active',
			removedUnsubscribeTag: true,
		})
		expect(removeUnsubscribeTag).toHaveBeenCalledWith('person@example.com')
	})

	it('fails when Kit still reports the unsubscribe tag after removal', async () => {
		const subscriber = {
			state: 'active',
			tags: [{ id: AI_HERO_UNSUBSCRIBED_TAG_ID }],
		}
		const getSubscriberByEmail = vi.fn().mockResolvedValue(subscriber)

		await expect(
			reconcileAiHeroEmailOptIn({
				email: 'person@example.com',
				subscriberState: 'active',
				getSubscriberByEmail,
				removeUnsubscribeTag: vi.fn().mockResolvedValue(undefined),
			}),
		).rejects.toThrow('Kit unsubscribe tag removal did not persist')
	})
})
