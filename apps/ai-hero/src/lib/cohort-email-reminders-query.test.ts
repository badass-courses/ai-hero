import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const query = {
		contentResource: {
			findFirst: vi.fn(),
		},
		contentResourceResource: {
			findFirst: vi.fn(),
		},
	}
	return {
		createEmail: vi.fn(),
		revalidateTag: vi.fn(),
		db: {
			query,
			transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
				const fakeTx = {
					isTx: true,
					query,
					insert: vi.fn().mockReturnValue({
						values: vi.fn().mockResolvedValue({}),
					}),
					delete: vi.fn().mockReturnValue({
						where: vi.fn().mockResolvedValue({}),
					}),
				}
				return await cb(fakeTx)
			}),
		},
	}
})

vi.mock('next/cache', () => ({
	revalidateTag: mocks.revalidateTag,
	revalidatePath: vi.fn(),
	unstable_cache: vi.fn((fn) => fn),
}))

vi.mock('@/db', () => ({
	db: mocks.db,
	courseBuilderAdapter: {},
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

vi.mock('@/lib/emails-query', () => ({
	createEmail: mocks.createEmail,
}))

import {
	attachReminderEmailToCohort,
	createAndAttachReminderEmailToCohort,
} from './cohort-email-reminders-query'

describe('createAndAttachReminderEmailToCohort', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('creates and attaches reminder email to cohort atomically inside a transaction', async () => {
		const createdEmail = { id: 'email_123', type: 'email', fields: { title: 'Reminder 1' } }
		mocks.createEmail.mockResolvedValue(createdEmail)
		mocks.db.query.contentResource.findFirst.mockResolvedValue({
			id: 'email_123',
			type: 'email',
		})

		const result = await createAndAttachReminderEmailToCohort('cohort_abc', {
			fields: { title: 'Reminder 1', body: 'Cohort starts tomorrow' },
		})

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.createEmail).toHaveBeenCalledWith(
			{ fields: { title: 'Reminder 1', body: 'Cohort starts tomorrow' } },
			{ tx: expect.objectContaining({ isTx: true }), revalidate: false },
		)
		expect(mocks.revalidateTag).toHaveBeenCalledWith('emails', 'max')
		expect(result).toEqual(createdEmail)
	})

	it('rolls back and skips cache revalidation if attachment fails', async () => {
		const createdEmail = { id: 'email_123', type: 'email', fields: { title: 'Reminder 1' } }
		mocks.createEmail.mockResolvedValue(createdEmail)
		// Email resource not found check in attach throws
		mocks.db.query.contentResource.findFirst.mockResolvedValue(null)

		await expect(
			createAndAttachReminderEmailToCohort('cohort_abc', {
				fields: { title: 'Reminder 1', body: 'Cohort starts tomorrow' },
			}),
		).rejects.toThrow('Email resource not found or not of type email')

		expect(mocks.db.transaction).toHaveBeenCalledOnce()
		expect(mocks.revalidateTag).not.toHaveBeenCalled()
	})
})
