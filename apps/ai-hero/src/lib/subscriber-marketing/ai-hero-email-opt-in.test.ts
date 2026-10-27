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

describe('reconcileAiHeroEmailOptIn with the untag disabled', () => {
	it('leaves a present tag in place and never calls Kit to remove it', async () => {
		const getSubscriberByEmail = vi.fn().mockResolvedValue({
			state: 'active',
			tags: [{ id: Number(AI_HERO_UNSUBSCRIBED_TAG_ID) }],
		})
		const removeUnsubscribeTag = vi.fn()

		await expect(
			reconcileAiHeroEmailOptIn({
				email: 'person@example.com',
				subscriberState: 'active',
				mayRemoveUnsubscribeTag: false,
				getSubscriberByEmail,
				removeUnsubscribeTag,
			}),
		).resolves.toEqual({
			status: 'active',
			removedUnsubscribeTag: false,
			untagSkipped: true,
		})
		expect(removeUnsubscribeTag).not.toHaveBeenCalled()
	})
})

describe('routeReturningUnsubscriber', () => {
	const tagged = {
		id: 123,
		state: 'active',
		tags: [{ id: Number(AI_HERO_UNSUBSCRIBED_TAG_ID) }],
	}
	const base = () => ({
		email: 'person@example.com',
		doiEnabled: true,
		drovrConfigured: true,
		formMapped: true,
		getSubscriberByEmail: vi.fn().mockResolvedValue(tagged),
		getDrovrStops: vi.fn().mockResolvedValue([]),
		requestDoi: vi.fn().mockResolvedValue(undefined),
	})

	it('tagged and drovr configured: requests DOI', async () => {
		const args = base()
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'doi-requested',
		})
		expect(args.requestDoi).toHaveBeenCalledTimes(1)
		expect(args.getDrovrStops).not.toHaveBeenCalled()
	})

	it('tagged with DOI disabled: blocked, no DOI request', async () => {
		const args = { ...base(), doiEnabled: false }
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'blocked',
			reason: 'doi-disabled',
		})
		expect(args.requestDoi).not.toHaveBeenCalled()
	})

	it('not tagged with DOI disabled: still not unsubscribed', async () => {
		const args = {
			...base(),
			doiEnabled: false,
			getSubscriberByEmail: vi
				.fn()
				.mockResolvedValue({ state: 'active', tags: [] }),
		}
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'not-unsubscribed',
		})
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

	it.each([
		[true, { status: 'doi-requested' }],
		[false, { status: 'blocked', reason: 'doi-disabled' }],
	])(
		'drovr-only unsubscribe with DOI enabled=%s',
		async (doiEnabled, expected) => {
			const args = {
				...base(),
				doiEnabled,
				getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 123, tags: [] }),
				getDrovrStops: vi.fn().mockResolvedValue([{ reason: 'unsubscribed' }]),
			}
			await expect(routeReturningUnsubscriber(args)).resolves.toEqual(expected)
			expect(args.getDrovrStops).toHaveBeenCalledWith('123')
			expect(args.requestDoi).toHaveBeenCalledTimes(doiEnabled ? 1 : 0)
		},
	)

	it.each([
		[{ formMapped: false }, 'unmapped-form'],
		[{ drovrConfigured: false }, 'drovr-unconfigured'],
	] as const)(
		'drovr-only unsubscribe respects remaining DOI gate %s',
		async (gate, reason) => {
			const args = {
				...base(),
				...gate,
				getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 123, tags: [] }),
				getDrovrStops: vi.fn().mockResolvedValue([{ reason: 'unsubscribed' }]),
			}
			await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
				status: 'blocked',
				reason,
			})
			expect(args.requestDoi).not.toHaveBeenCalled()
		},
	)

	it.each(['bounced', 'complained', 'future-reason'])(
		'blocks %s even alongside an unsubscribe',
		async (reason) => {
			const args = {
				...base(),
				getSubscriberByEmail: vi
					.fn()
					.mockResolvedValue({ id: '123', tags: [] }),
				getDrovrStops: vi
					.fn()
					.mockResolvedValue([{ reason: 'unsubscribed' }, { reason }]),
			}
			await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
				status: 'blocked',
				reason: 'suppressed',
			})
			expect(args.requestDoi).not.toHaveBeenCalled()
		},
	)

	it('no active drovr stops: not unsubscribed', async () => {
		const args = {
			...base(),
			getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 123, tags: [] }),
		}
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'not-unsubscribed',
		})
		expect(args.getDrovrStops).toHaveBeenCalledWith('123')
		expect(args.requestDoi).not.toHaveBeenCalled()
	})

	it.each([
		[{}, { status: 'doi-requested' }, 1],
		[{ doiEnabled: false }, { status: 'blocked', reason: 'drovr-unknown' }, 0],
		[{ formMapped: false }, { status: 'blocked', reason: 'drovr-unknown' }, 0],
		[
			{ drovrConfigured: false },
			{ status: 'blocked', reason: 'drovr-unknown' },
			0,
		],
	] as const)(
		'unknown drovr consent respects DOI gates %s',
		async (gate, expected, doiCalls) => {
			const args = {
				...base(),
				...gate,
				getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 123, tags: [] }),
				getDrovrStops: vi.fn().mockRejectedValue(new Error('offline')),
			}
			await expect(routeReturningUnsubscriber(args)).resolves.toEqual(expected)
			expect(args.requestDoi).toHaveBeenCalledTimes(doiCalls)
		},
	)

	it('unknown drovr consent never masks a failed DOI request', async () => {
		const args = {
			...base(),
			getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 123, tags: [] }),
			getDrovrStops: vi.fn().mockRejectedValue(new Error('offline')),
			requestDoi: vi.fn().mockRejectedValue(new Error('queue failed')),
		}
		await expect(routeReturningUnsubscriber(args)).rejects.toThrow(
			'queue failed',
		)
	})

	it('Kit lookup fails: reports lookup-failed so the sign-up can continue', async () => {
		const args = {
			...base(),
			getSubscriberByEmail: vi.fn().mockRejectedValue(new Error('down')),
		}
		await expect(routeReturningUnsubscriber(args)).resolves.toEqual({
			status: 'lookup-failed',
		})
		expect(args.requestDoi).not.toHaveBeenCalled()
	})
})
