import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cookieGet: vi.fn(),
	getServerAuthSession: vi.fn(),
	getSubscriberFromCookie: vi.fn(),
	inngestSend: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	reconcile: vi.fn(),
	revalidatePath: vi.fn(),
	setSubscriberCookie: vi.fn(),
	subscribeToList: vi.fn(),
}))

vi.mock('next/cache', () => ({
	revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: mocks.cookieGet,
	}),
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		subscribeToList: mocks.subscribeToList,
	},
}))

vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
	setSubscriberCookie: mocks.setSubscriberCookie,
}))

// Mocked for reach, not just behaviour: importing the real module pulls
// next-auth in, which cannot resolve `next/server` under vitest.
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

// `server-only` is a build-time guard with no runtime module, so vitest cannot
// resolve it. Stubbed rather than removed from the source: the guard is what
// keeps a session read out of a client bundle.
vi.mock('server-only', () => ({}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		send: mocks.inngestSend,
	},
}))

vi.mock('@/schemas/subscriber', () => ({
	SubscriberSchema: {
		parse: (value: unknown) => value,
	},
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
}))

vi.mock('@/lib/subscriber-marketing/ai-hero-email-opt-in.server', () => ({
	reconcileAiHeroEmailOptInWithKit: mocks.reconcile,
}))

vi.mock('@/lib/subscriber-marketing/opt-in-attribution', () => ({
	parseOptInAttributionCookie: () => undefined,
}))

import { tagSubscriberAsSkills } from './skills-newsletter-actions'

describe('tagSubscriberAsSkills', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		const subscriber = {
			id: 1,
			email_address: 'contact',
			first_name: null,
			state: 'active',
			fields: {},
		}
		mocks.getSubscriberFromCookie.mockResolvedValue(subscriber)
		mocks.subscribeToList.mockResolvedValue(subscriber)
		mocks.reconcile.mockResolvedValue({ status: 'active' })
		mocks.inngestSend.mockResolvedValue(undefined)
		mocks.cookieGet.mockReturnValue(undefined)
		mocks.getServerAuthSession.mockResolvedValue(null)
	})

	// A signed-in reader is identified without a Kit cookie. Before this they
	// were told "we could not find your subscription — try the form instead",
	// which asked a known person to type an address the server already had.
	it('enrols a signed-in reader with no Kit cookie, using their account email', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue(null)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'signed-in@example.com', name: 'Vojta' } },
		})

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ email: 'signed-in@example.com' }),
			}),
		)
	})

	// The cookie carries the real Kit record; a session only carries an address.
	// Preferring the session would split a reader who changed their Kit email
	// into two subscribers.
	it('prefers the Kit cookie over the session when both exist', async () => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { email: 'signed-in@example.com' } },
		})

		await tagSubscriberAsSkills('skills-post')

		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ email: 'contact' }),
			}),
		)
	})

	it('still reports not-subscribed with neither cookie nor session', async () => {
		mocks.getSubscriberFromCookie.mockResolvedValue(null)

		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: false, reason: 'not-subscribed' })
		expect(mocks.subscribeToList).not.toHaveBeenCalled()
	})

	it('emits course entry with the placement source when ft_attr is absent', async () => {
		const result = await tagSubscriberAsSkills('skills-post')

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					source: 'aihero_skills_post',
				}),
			}),
		)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					source: 'aihero_skills_post',
					optInAttribution: undefined,
				}),
			}),
		)
		expect(mocks.setSubscriberCookie).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					interest: 'skills',
					source: 'aihero_skills_post',
				}),
			}),
		)
	})
})
