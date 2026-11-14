import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	where: vi.fn(),
	select: vi.fn(),
	resolve: vi.fn(),
	send: vi.fn(),
	info: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { select: mocks.select } }))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: mocks.send } }))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
vi.mock('./drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('./drovr-doi-signup', async (importOriginal) => ({
	...(await importOriginal<typeof import('./drovr-doi-signup')>()),
	resolveDoiSignupContact: mocks.resolve,
}))

import { contact } from '@/db/schema'
import { requestDrovrDoiSignup } from './drovr-doi-signup.server'
import { DoiSignupContactAmbiguousError } from './drovr-doi-signup'

describe('DOI signup contact query and resolution logging', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.info.mockResolvedValue(undefined)
		mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) })
		mocks.where.mockResolvedValue([
			{
				id: 'contact-a',
				userId: null,
				createdAt: new Date('2026-07-16T00:00:00Z'),
			},
			{
				id: 'contact-b',
				userId: null,
				createdAt: new Date('2026-07-17T00:00:00Z'),
			},
			{
				id: 'contact-c',
				userId: 'user-1',
				createdAt: new Date('2026-07-18T00:00:00Z'),
			},
		])
	})

	it('fetches all ordering metadata and logs only the candidate count and rule', async () => {
		mocks.resolve.mockImplementationOnce(async (args) => {
			const candidates = await args.findContactsByEmailKey('synthetic-key')
			expect(candidates).toHaveLength(3)
			expect(candidates[2]).toEqual({
				id: 'contact-c',
				userId: 'user-1',
				createdAt: '2026-07-18T00:00:00.000Z',
			})
			await args.onAmbiguousResolved({ candidateCount: 3, rule: 'single-user' })
			return { contactId: 'contact-c' }
		})
		await expect(
			requestDrovrDoiSignup({
				email: 'learner@example.test',
				kitFormId: 8447166,
				page: '/',
				entry: 'form',
			}),
		).resolves.toEqual({ contactId: 'contact-c' })
		expect(mocks.select).toHaveBeenCalledWith({
			id: contact.id,
			userId: contact.userId,
			createdAt: contact.createdAt,
		})
		expect(
			mocks.info.mock.calls.filter(
				([event]) => event === 'doi.signup.contact.ambiguous_resolved',
			),
		).toEqual([
			[
				'doi.signup.contact.ambiguous_resolved',
				{ candidateCount: 3, rule: 'single-user' },
			],
		])
		expect(mocks.send).toHaveBeenCalledTimes(1)
	})

	it.each([new Date('2026-07-16T00:00:00.000Z'), '2026-07-16T00:00:00.000Z'])(
		'accepts an orderable driver timestamp: %s',
		async (createdAt) => {
			mocks.where.mockResolvedValueOnce([
				{ id: 'contact-a', userId: null, createdAt },
			])
			mocks.resolve.mockImplementationOnce(async (args) => {
				expect(await args.findContactsByEmailKey('synthetic-key')).toEqual([
					{
						id: 'contact-a',
						userId: null,
						createdAt: '2026-07-16T00:00:00.000Z',
					},
				])
				return { contactId: 'contact-a' }
			})
			await expect(
				requestDrovrDoiSignup({
					email: 'learner@example.test',
					kitFormId: 8447166,
					page: '/',
					entry: 'form',
				}),
			).resolves.toEqual({ contactId: 'contact-a' })
		},
	)

	it.each([undefined, null, 'invalid', new Date(NaN), 0])(
		'refuses an unorderable driver timestamp: %s',
		async (createdAt) => {
			mocks.where.mockResolvedValueOnce([
				{ id: 'contact-a', userId: null, createdAt },
			])
			mocks.resolve.mockImplementationOnce(async (args) => {
				await args.findContactsByEmailKey('synthetic-key')
				return { contactId: 'contact-a' }
			})
			await expect(
				requestDrovrDoiSignup({
					email: 'learner@example.test',
					kitFormId: 8447166,
					page: '/',
					entry: 'form',
				}),
			).rejects.toBeInstanceOf(DoiSignupContactAmbiguousError)
			expect(mocks.send).not.toHaveBeenCalled()
		},
	)

	it('still submits the signup if the ambiguity log rejects', async () => {
		mocks.info.mockRejectedValueOnce(new Error('Log transport unavailable'))
		mocks.resolve.mockImplementationOnce(async (args) => {
			await args.onAmbiguousResolved({
				candidateCount: 2,
				rule: 'oldest-created-at-then-id',
			})
			return { contactId: 'contact-a' }
		})
		await expect(
			requestDrovrDoiSignup({
				email: 'learner@example.test',
				kitFormId: 8447166,
				page: '/',
				entry: 'form',
			}),
		).resolves.toEqual({ contactId: 'contact-a' })
		expect(mocks.send).toHaveBeenCalledTimes(1)
	})
})
