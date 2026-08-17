import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	resolveEnrolmentIdentity: vi.fn(),
	inngestSend: vi.fn(),
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
		mocks.log.info.mockResolvedValue(undefined)
		mocks.log.warn.mockResolvedValue(undefined)
		mocks.log.error.mockResolvedValue(undefined)
	})

	it('queues the intent without synthesizing field confirmation', async () => {
		const result = await addWorkshopInterest(
			'ai-coding-crash-course',
			'post-closing',
		)

		expect(result).toEqual({
			success: true,
			gate: {
				state: 'active',
				fields: {},
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

	it('reports a truthful failure when the durable enqueue fails', async () => {
		mocks.inngestSend.mockRejectedValueOnce(new Error('inngest unavailable'))

		await expect(
			addWorkshopInterest('ai-coding-crash-course'),
		).resolves.toEqual({ success: false, reason: 'request-failed' })
		expect(mocks.log.error).toHaveBeenCalledWith(
			'workshop.interest.failed',
			expect.objectContaining({
				phase: 'enqueue',
				error: 'inngest unavailable',
			}),
		)
	})
})
