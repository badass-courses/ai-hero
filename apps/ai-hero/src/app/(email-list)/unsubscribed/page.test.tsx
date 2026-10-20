import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	updateProviderEmailPreference: vi.fn(),
	syncLocalEmailPreference: vi.fn(),
	unsubscribeLocalEmailPreferenceByUserId: vi.fn(),
	validateKitPreferenceIdentity: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({
	redirect: (to: string) => {
		throw new Error(`redirect:${to}`)
	},
}))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('@/components/layout-client', () => ({ default: () => null }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/lib/email-preferences', async () => {
	const actual = await vi.importActual<
		typeof import('@/lib/email-preferences')
	>('@/lib/email-preferences')
	return {
		...actual,
		updateProviderEmailPreference: mocks.updateProviderEmailPreference,
		syncLocalEmailPreference: mocks.syncLocalEmailPreference,
		unsubscribeLocalEmailPreferenceByUserId:
			mocks.unsubscribeLocalEmailPreferenceByUserId,
		validateKitPreferenceIdentity: mocks.validateKitPreferenceIdentity,
	}
})

import Unsubscribed from './page'

const identity = { ck_subscriber_id: '123', sh_kit: 'abc' }

const render = (params: Record<string, string>) =>
	Unsubscribed({ searchParams: Promise.resolve(params) })

function expectNoWrites() {
	expect(mocks.updateProviderEmailPreference).not.toHaveBeenCalled()
	expect(mocks.syncLocalEmailPreference).not.toHaveBeenCalled()
	expect(mocks.unsubscribeLocalEmailPreferenceByUserId).not.toHaveBeenCalled()
}

describe('/unsubscribed', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.validateKitPreferenceIdentity.mockResolvedValue({
			email_address: 'a@example.com',
		})
		mocks.updateProviderEmailPreference.mockResolvedValue({
			subscribed: false,
			status: 'updated',
		})
		mocks.unsubscribeLocalEmailPreferenceByUserId.mockResolvedValue({
			userId: 'u1',
		})
	})

	it.each(['cohorts', 'cohort-004', 'ohort-004'])(
		'%s makes no provider or local write',
		async (preference) => {
			await render({ preference, ...identity })
			await render({ preference, userId: 'u1' })
			expectNoWrites()
			expect(mocks.validateKitPreferenceIdentity).not.toHaveBeenCalled()
			expect(mocks.log.warn).not.toHaveBeenCalled()
		},
	)

	it('an unknown preference makes no write, logs it, and offers preferences', async () => {
		const result = (await render({ preference: 'foo', ...identity })) as any
		const local = (await render({ preference: 'foo', userId: 'u1' })) as any

		expectNoWrites()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'email-preferences.unknown_preference',
			expect.objectContaining({ preference: 'foo' }),
		)
		expect(result.props.managePreferencesHref).toBe(
			'/preferences?ck_subscriber_id=123&sh_kit=abc',
		)
		expect(local.props.managePreferencesHref).toBe('/preferences')
	})

	it('a known newsletter key still unsubscribes', async () => {
		await render({ preference: 'newsletter', ...identity })
		expect(mocks.updateProviderEmailPreference).toHaveBeenCalledWith(
			expect.objectContaining({ subscribed: false }),
		)
		expect(mocks.syncLocalEmailPreference).toHaveBeenCalledTimes(1)

		await render({ preference: 'newsletter', userId: 'u1' })
		expect(mocks.unsubscribeLocalEmailPreferenceByUserId).toHaveBeenCalledTimes(
			1,
		)
		expect(mocks.log.warn).not.toHaveBeenCalled()
	})
})
