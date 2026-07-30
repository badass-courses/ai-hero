import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cookieGet: vi.fn(),
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
	})

	it('emits course entry with the placement source when ft_attr is absent', async () => {
		const result = await tagSubscriberAsSkills(
			'skill_page_course:skills-handoff',
		)

		expect(result).toEqual({ success: true })
		expect(mocks.subscribeToList).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.objectContaining({
					source: 'skill_page_course:skills-handoff',
				}),
			}),
		)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					source: 'skill_page_course:skills-handoff',
					optInAttribution: undefined,
				}),
			}),
		)
	})
})
