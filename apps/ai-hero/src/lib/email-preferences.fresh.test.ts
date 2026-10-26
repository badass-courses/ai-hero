import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => ({ cache: (fn: unknown) => fn }))
vi.mock('@/env.mjs', () => ({
	env: {
		CONVERTKIT_API_KEY: 'synthetic-key',
		CONVERTKIT_API_SECRET: 'synthetic-secret',
		CONVERTKIT_SIGNUP_FORM: '123',
	},
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/db/schema', () => ({ communicationPreferences: {}, users: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	serializeError: vi.fn(),
}))
vi.mock('@/server/perf', () => ({
	measureIfSlow: ({ operation }: { operation: () => Promise<unknown> }) =>
		operation(),
}))

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { getEmailPreferenceSubscriber } from './email-preferences'

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('preferences consent reads bypass the subscriber cache', () => {
	it('reads fresh opt-out tags after a cached subscriber has old tags', async () => {
		let optedOut = false
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname
			if (path.endsWith('/tags')) {
				return Response.json({ tags: optedOut ? [{ id: 9001 }] : [] })
			}
			return Response.json({
				subscriber: {
					id: 424242,
					email_address: 'consent-cache@example.test',
					state: optedOut ? 'cancelled' : 'active',
					fields: {},
				},
			})
		})
		vi.stubGlobal('fetch', fetch)

		await expect(
			emailListProvider.getSubscriber('424242'),
		).resolves.toMatchObject({
			state: 'active',
			tags: { tags: [] },
		})
		optedOut = true
		// Display/identity readers still hold the old three-minute snapshot.
		await expect(
			emailListProvider.getSubscriber('424242'),
		).resolves.toMatchObject({
			state: 'active',
			tags: { tags: [] },
		})
		expect(fetch).toHaveBeenCalledTimes(2)

		await expect(
			getEmailPreferenceSubscriber({
				subscriberId: '424242',
				source: 'preferences-page',
			}),
		).resolves.toMatchObject({
			state: 'cancelled',
			tags: { tags: [{ id: 9001 }] },
		})
		expect(fetch).toHaveBeenCalledTimes(4)
	})
})
