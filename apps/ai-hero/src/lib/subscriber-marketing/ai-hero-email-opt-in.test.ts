import { describe, expect, it, vi } from 'vitest'

import {
	AI_HERO_UNSUBSCRIBED_TAG_ID,
	reconcileAiHeroEmailOptIn,
	routeReturningUnsubscriber,
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

	it('accepts the nested Kit tags response shape without throwing', async () => {
		const getSubscriberByEmail = vi.fn().mockResolvedValue({
			state: 'active',
			tags: { tags: [] },
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

	it('removes a stale unsubscribe tag reported through the nested shape', async () => {
		const getSubscriberByEmail = vi
			.fn()
			.mockResolvedValueOnce({
				state: 'active',
				tags: { tags: [{ id: AI_HERO_UNSUBSCRIBED_TAG_ID }] },
			})
			.mockResolvedValueOnce({ state: 'active', tags: { tags: [] } })
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

	it('rejects an unsupported tags shape loudly', async () => {
		const getSubscriberByEmail = vi.fn().mockResolvedValue({
			state: 'active',
			tags: 'not-a-tags-shape',
		})

		await expect(
			reconcileAiHeroEmailOptIn({
				email: 'person@example.com',
				subscriberState: 'active',
				getSubscriberByEmail,
				removeUnsubscribeTag: vi.fn(),
			}),
		).rejects.toThrow('Kit subscriber tags response has an unsupported shape')
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

describe('routeReturningUnsubscriber', () => {
	const tagged = {
		state: 'active',
		tags: [{ id: Number(AI_HERO_UNSUBSCRIBED_TAG_ID) }],
	}
	const base = () => ({
		email: 'person@example.com',
		drovrConfigured: true,
		formMapped: true,
		getSubscriberByEmail: vi.fn().mockResolvedValue(tagged),
		requestDoi: vi.fn().mockResolvedValue(undefined),
	})

	it('tagged and drovr configured: requests DOI', async () => {
		const args = base()
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'doi-requested',
		})
		expect(args.requestDoi).toHaveBeenCalledTimes(1)
	})

	it('tagged and drovr not configured: blocked, no DOI request', async () => {
		const args = { ...base(), drovrConfigured: false }
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'blocked',
			reason: 'drovr-unconfigured',
		})
		expect(args.requestDoi).not.toHaveBeenCalled()
	})

	it('tagged on a form with no drovr form: blocked, no DOI request', async () => {
		const args = { ...base(), formMapped: false }
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'blocked',
			reason: 'unmapped-form',
		})
		expect(args.requestDoi).not.toHaveBeenCalled()
	})

	it.each([
		['no subscriber', null],
		['no tags', { state: 'active', tags: [] }],
		['other tags', { state: 'active', tags: [{ id: 1 }] }],
	])('%s: not unsubscribed, nothing requested', async (_name, subscriber) => {
		const args = {
			...base(),
			getSubscriberByEmail: vi.fn().mockResolvedValue(subscriber),
		}
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'not-unsubscribed',
		})
		expect(args.requestDoi).not.toHaveBeenCalled()
	})

	it('Kit lookup fails: blocked, fails closed', async () => {
		const args = {
			...base(),
			getSubscriberByEmail: vi.fn().mockRejectedValue(new Error('down')),
		}
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'blocked',
			reason: 'lookup-failed',
		})
		expect(args.requestDoi).not.toHaveBeenCalled()
	})
})
