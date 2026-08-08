import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	resolveEnrolmentIdentity: vi.fn(),
	inngestSend: vi.fn(),
	setSubscriberCookie: vi.fn(),
	revalidatePath: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))

vi.mock('@/lib/convertkit', () => ({
	setSubscriberCookie: mocks.setSubscriberCookie,
}))

vi.mock('@/lib/enrolment-identity', () => ({
	resolveEnrolmentIdentity: mocks.resolveEnrolmentIdentity,
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { addWorkshopInterest } from './workshop-interest-actions'

const subscriber = {
	id: 42,
	first_name: 'Reader',
	email_address: 'reader@example.com',
	state: 'active',
	fields: { existing: 'kept' },
}

describe('addWorkshopInterest', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-08-08T12:34:56.000Z'))
		mocks.resolveEnrolmentIdentity.mockResolvedValue({
			identity: {
				email: 'reader@example.com',
				name: 'Reader',
				via: 'cookie',
			},
			subscriber,
		})
		mocks.inngestSend.mockResolvedValue(undefined)
		mocks.setSubscriberCookie.mockResolvedValue(undefined)
		mocks.log.info.mockResolvedValue(undefined)
		mocks.log.warn.mockResolvedValue(undefined)
		mocks.log.error.mockResolvedValue(undefined)
	})

	it('accepts the click, queues the canonical intent, and updates the cookie', async () => {
		const result = await addWorkshopInterest(
			'ai-coding-crash-course',
			'post-closing',
		)

		expect(result).toEqual({
			success: true,
			gate: {
				state: 'active',
				fields: {
					interest_ai_coding_crash_course: '2026-08-08',
				},
			},
		})
		expect(mocks.inngestSend).toHaveBeenCalledWith({
			name: 'workshop/interest.requested',
			data: {
				email: 'reader@example.com',
				name: 'Reader',
				workshopSlug: 'ai-coding-crash-course',
				surface: 'post-closing',
				expressedAt: '2026-08-08T12:34:56.000Z',
				via: 'cookie',
				subscriberId: 42,
			},
		})
		expect(mocks.setSubscriberCookie).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 42,
				fields: {
					existing: 'kept',
					interest_ai_coding_crash_course: '2026-08-08',
					source: 'aihero_post_closing',
				},
			}),
		)
		expect(mocks.log.info).toHaveBeenCalledWith(
			'workshop.interest.deferred',
			expect.objectContaining({
				fieldKey: 'interest_ai_coding_crash_course',
				intentKey: 'interest:workshop:ai_coding_crash_course',
			}),
		)
		expect(mocks.revalidatePath).toHaveBeenCalledWith(
			'/workshops/ai-coding-crash-course',
		)
	})

	it('returns success after enqueue when the optimistic cookie write fails', async () => {
		mocks.setSubscriberCookie.mockRejectedValueOnce(new Error('cookies closed'))

		await expect(
			addWorkshopInterest('ai-coding-crash-course'),
		).resolves.toMatchObject({ success: true })
		expect(mocks.log.error).toHaveBeenCalledWith(
			'workshop.interest.cookie.failed',
			expect.objectContaining({ error: 'cookies closed' }),
		)
	})

	it('reports a truthful failure when the durable enqueue fails', async () => {
		mocks.inngestSend.mockRejectedValueOnce(new Error('inngest unavailable'))

		await expect(
			addWorkshopInterest('ai-coding-crash-course'),
		).resolves.toEqual({ success: false, reason: 'request-failed' })
		expect(mocks.setSubscriberCookie).not.toHaveBeenCalled()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'workshop.interest.failed',
			expect.objectContaining({
				phase: 'enqueue',
				error: 'inngest unavailable',
			}),
		)
	})
})
