import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verify: vi.fn(),
	cookie: vi.fn(),
}))
vi.mock('next/headers', () => ({
	cookies: async () => ({ get: (name: string) => mocks.cookie(name) }),
}))
vi.mock('@/lib/email-preferences', () => ({
	verifyKitPreferenceLinkLocally: mocks.verify,
}))

import {
	normalizeSubscriberIdCookie,
	readVerifiedLinkSubscriber,
} from './survey-link-identity'

const subscriber = {
	id: '12345',
	email_address: 'reader@example.test',
	contactId: 'contact-reader',
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.cookie.mockReturnValue(undefined)
	mocks.verify.mockResolvedValue({ status: 'verified', subscriber })
})

describe('readVerifiedLinkSubscriber', () => {
	it('never resolves a subscriber id without sh_kit', async () => {
		mocks.cookie.mockReturnValue({ value: '12345' })
		expect(
			await readVerifiedLinkSubscriber({
				subscriberId: '12345',
				route: '/survey',
			}),
		).toBeNull()
		expect(mocks.verify).not.toHaveBeenCalled()
	})

	it('returns nothing when the hash does not match', async () => {
		mocks.verify.mockResolvedValue({
			status: 'invalid',
			reason: 'hash-mismatch',
		})
		expect(
			await readVerifiedLinkSubscriber({
				subscriberId: '12345',
				shKit: 'b'.repeat(64),
				route: '/survey',
			}),
		).toBeNull()
	})

	it('verifies the link id with its hash', async () => {
		expect(
			await readVerifiedLinkSubscriber({
				subscriberId: 12345,
				shKit: 'a'.repeat(64),
				route: '/survey',
			}),
		).toEqual(subscriber)
		expect(mocks.verify).toHaveBeenCalledWith({
			subscriberId: '12345',
			shKit: 'a'.repeat(64),
			source: 'survey-link',
			route: '/survey',
		})
	})

	it('falls back to the ck_subscriber_id cookie once the URL id is stripped', async () => {
		mocks.cookie.mockReturnValue({ value: '"12345"' })
		await readVerifiedLinkSubscriber({
			shKit: 'a'.repeat(64),
			route: '/survey',
		})
		expect(mocks.cookie).toHaveBeenCalledWith('ck_subscriber_id')
		expect(mocks.verify).toHaveBeenCalledWith(
			expect.objectContaining({ subscriberId: '12345' }),
		)
	})

	it('normalizes bare and JSON-encoded cookie ids', () => {
		expect(normalizeSubscriberIdCookie('12345')).toBe('12345')
		expect(normalizeSubscriberIdCookie('"12345"')).toBe('12345')
		expect(normalizeSubscriberIdCookie(undefined)).toBe('')
	})
})
