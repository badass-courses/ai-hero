import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordSignupAttribution } from './signup-attribution'

const mocks = vi.hoisted(() => {
	const insertValues = vi.fn()
	const insert = vi.fn(() => ({ values: insertValues }))
	return {
		insert,
		insertValues,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	}
})

vi.mock('@/db', () => ({
	db: {
		insert: mocks.insert,
	},
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
}))

vi.mock('@coursebuilder/utils/guid', () => ({
	guid: () => 'guid_signup_attr',
}))

const realCookie = JSON.stringify({
	utm_source: 'google',
	utm_medium: 'organic',
	landing_path: '/blog/some-post',
	referrer: 'https://www.google.com/',
	click_ids: { gclid: 'Cj0KCQ' },
	captured_at: '2026-07-25T12:00:00.000Z',
})

const skillsCookie = JSON.stringify({
	landing_path: '/skills',
	referrer: 'https://t.co/abc',
	captured_at: '2026-07-25T12:00:00.000Z',
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.insertValues.mockResolvedValue(undefined)
})

describe('recordSignupAttribution', () => {
	it('writes a row with landing path and referrer for a non-Skills signup', async () => {
		const result = await recordSignupAttribution({
			email: 'reader@example.com',
			formId: 111,
			kitSubscriberId: 42,
			rawCookie: realCookie,
		})

		expect(result).toBe('captured')
		expect(mocks.insert).toHaveBeenCalledTimes(1)
		expect(mocks.insertValues).toHaveBeenCalledWith({
			id: 'guid_signup_attr',
			email: 'reader@example.com',
			kitSubscriberId: '42',
			formId: '111',
			landingPath: '/blog/some-post',
			referrer: 'https://www.google.com/',
			utmSource: 'google',
			utmMedium: 'organic',
			utmCampaign: undefined,
			utmContent: undefined,
			utmTerm: undefined,
			clickIds: { gclid: 'Cj0KCQ' },
			capturedAt: new Date('2026-07-25T12:00:00.000Z'),
		})
		expect(mocks.log.info).toHaveBeenCalledWith('signup.attribution.captured', {
			formId: '111',
			hasLandingPath: true,
			hasReferrer: true,
			kitSubscriberId: '42',
		})
		expect(mocks.log.info.mock.calls[0]?.[1]).not.toHaveProperty('email')
	})

	it('writes a row for a Skills form signup (formId 9376133)', async () => {
		const result = await recordSignupAttribution({
			email: 'skills@example.com',
			formId: 9376133,
			kitSubscriberId: 99,
			rawCookie: skillsCookie,
		})

		expect(result).toBe('captured')
		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'skills@example.com',
				formId: '9376133',
				landingPath: '/skills',
				referrer: 'https://t.co/abc',
				kitSubscriberId: '99',
			}),
		)
	})

	it('skips quietly when there is no cookie', async () => {
		const result = await recordSignupAttribution({
			email: 'nobody@example.com',
			formId: 111,
			rawCookie: null,
		})

		expect(result).toBe('skipped')
		expect(mocks.insert).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith('signup.attribution.skipped', {
			reason: 'no_cookie',
		})
	})

	it('skips synthetic test click ids', async () => {
		const result = await recordSignupAttribution({
			email: 'test@example.com',
			formId: 111,
			rawCookie: JSON.stringify({
				landing_path: '/skills',
				click_ids: { gclid: 'TEST_signup_1' },
				captured_at: '2026-07-25T12:00:00.000Z',
			}),
		})

		expect(result).toBe('skipped')
		expect(mocks.insert).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith('signup.attribution.skipped', {
			reason: 'synthetic',
		})
	})

	it('treats duplicate-key violations as success', async () => {
		mocks.insertValues.mockRejectedValueOnce({
			code: 'ER_DUP_ENTRY',
			errno: 1062,
			message: "Duplicate entry 'reader@example.com-111' for key",
		})

		const result = await recordSignupAttribution({
			email: 'reader@example.com',
			formId: 111,
			rawCookie: realCookie,
		})

		expect(result).toBe('duplicate')
		expect(mocks.log.warn).toHaveBeenCalledWith('signup.attribution.skipped', {
			reason: 'duplicate',
			formId: '111',
			kitSubscriberId: undefined,
		})
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('logs insert failure and does not throw', async () => {
		mocks.insertValues.mockRejectedValueOnce(new Error('db down'))

		const result = await recordSignupAttribution({
			email: 'reader@example.com',
			formId: 111,
			rawCookie: realCookie,
		})

		expect(result).toBe('failed')
		expect(mocks.log.error).toHaveBeenCalledWith('signup.attribution.failed', {
			formId: '111',
			error: 'db down',
		})
	})
})
