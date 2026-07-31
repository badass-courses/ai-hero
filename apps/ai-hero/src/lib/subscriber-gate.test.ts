import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cookies: new Map<string, string>(),
	getSubscriberFromCookie: vi.fn(),
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = mocks.cookies.get(name)
			return value === undefined ? undefined : { value }
		},
	}),
}))

vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))

import { getSubscriberForGating } from './subscriber-gate'

describe('getSubscriberForGating identity', () => {
	beforeEach(() => {
		mocks.cookies.clear()
		vi.clearAllMocks()
	})

	it('keeps usable identity in the compact gate cookie', async () => {
		mocks.cookies.set(
			'ck_subscriber_gate',
			JSON.stringify({
				id: 42,
				email_address: 'reader@example.com',
				state: 'active',
				fields: { waitlist_cohort_four: '2026-07-31' },
			}),
		)

		await expect(getSubscriberForGating()).resolves.toMatchObject({
			id: 42,
			email_address: 'reader@example.com',
		})
	})

	it('normalizes a missing gate state before parsing the subscriber', async () => {
		mocks.cookies.set(
			'ck_subscriber_gate',
			JSON.stringify({
				id: 42,
				email_address: 'reader@example.com',
				state: null,
				fields: {},
			}),
		)

		await expect(getSubscriberForGating()).resolves.toMatchObject({
			id: 42,
			email_address: 'reader@example.com',
		})
	})

	it('migrates identity from a matching full cookie without calling Kit', async () => {
		mocks.cookies.set(
			'ck_subscriber_gate',
			JSON.stringify({
				id: 42,
				state: 'active',
				fields: { waitlist_cohort_four: '2026-07-31' },
			}),
		)
		mocks.cookies.set(
			'ck_subscriber',
			JSON.stringify({
				id: 42,
				email_address: 'reader@example.com',
				state: 'active',
				fields: {},
			}),
		)

		await expect(getSubscriberForGating()).resolves.toMatchObject({
			id: 42,
			email_address: 'reader@example.com',
			fields: { waitlist_cohort_four: '2026-07-31' },
		})
		expect(mocks.getSubscriberFromCookie).not.toHaveBeenCalled()
	})
})
