import { beforeEach, describe, expect, it, vi } from 'vitest'
import { directoryBirthEvents } from './contact-sync-straggler-retry'
import { admitValuePathBirths } from './drovr-value-path-birth-admission'
import { prepareDirectoryBirths } from './drovr-directory-birth-standing'

const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	tags: vi.fn(),
	createReader: vi.fn(() => ({})),
}))
vi.mock('@/db', () => ({ db: { select: mocks.select } }))
vi.mock('./signup-confirmation-kit-reader', () => ({
	createKitReader: mocks.createReader,
	fetchKitSubscriberTagIds: mocks.tags,
}))
import { readDirectoryBirthStanding } from './drovr-directory-birth-standing-live'

const birth = () =>
	directoryBirthEvents({
		contact: {
			id: 'contact-1',
			email: 'test@example.com',
			name: null,
			userId: null,
			isProvisional: true,
			lifecycle: 'new',
			createdAt: '2026-10-01T00:00:00Z',
			updatedAt: '2026-10-01T00:00:00Z',
		},
		kitSubscriberId: '42',
	})[0]!

const query = (rows: unknown[]) => ({
	from: () => ({ where: async () => rows }),
})
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv('CONVERTKIT_V4_API_KEY', 'test-key')
	mocks.select.mockReturnValue(query([]))
	mocks.tags.mockResolvedValue(new Set())
})

describe('directory births use contact-sync stop standing', () => {
	it('sends a Kit-active tagged contact birth as unsubscribed through the shared delivery gate', async () => {
		mocks.tags.mockResolvedValue(new Set(['8244351']))
		const original = birth()
		const result = await admitValuePathBirths({
			events: [original],
			read: vi.fn(),
			info: vi.fn(),
			readDirectoryStanding: readDirectoryBirthStanding,
		})
		expect(result.events[0]).toMatchObject({
			type: 'contact.created',
			payload: { lifecycle: 'unsubscribed', sourceLifecycle: 'new' },
		})
		expect(result.events[0]?.idempotencyKey).toBe(original.idempotencyKey)
		expect(original.payload).toMatchObject({ lifecycle: 'provisional' })
		expect(mocks.tags).toHaveBeenCalledWith(expect.anything(), '42')
	})

	it('leaves an untagged birth provisional', async () => {
		expect(
			(await prepareDirectoryBirths([birth()], readDirectoryBirthStanding))[0]
				?.payload,
		).toMatchObject({ lifecycle: 'provisional' })
	})

	it('uses a stored Kit alias when the birth omits the subscriber id', async () => {
		mocks.select
			.mockReturnValueOnce(query([]))
			.mockReturnValueOnce(
				query([{ contactId: 'contact-1', externalId: '99' }]),
			)
		mocks.tags.mockResolvedValue(new Set(['8244351']))
		const event = birth()
		delete (event.payload as { kitSubscriberId?: string }).kitSubscriberId
		expect(
			(await prepareDirectoryBirths([event], readDirectoryBirthStanding))[0]
				?.payload,
		).toMatchObject({ lifecycle: 'unsubscribed' })
		expect(mocks.tags).toHaveBeenCalledWith(expect.anything(), '99')
	})

	it.each(['contact.unsubscribed', 'contact.bounced', 'contact.complained'])(
		'births a recorded %s as stopped without a Kit read',
		async (eventType) => {
			mocks.select
				.mockReturnValueOnce(
					query([
						{
							contactId: 'contact-1',
							eventType,
							occurredAt: '2026-10-02T00:00:00Z',
						},
					]),
				)
				.mockReturnValueOnce(query([]))
			expect(
				(await prepareDirectoryBirths([birth()], readDirectoryBirthStanding))[0]
					?.payload,
			).toMatchObject({
				lifecycle:
					eventType === 'contact.unsubscribed' ? 'unsubscribed' : 'bounced',
			})
			expect(mocks.tags).not.toHaveBeenCalled()
		},
	)

	it('lifts an old recorded opt-out only after fresh DOI and a clear current tag read', async () => {
		mocks.select
			.mockReturnValueOnce(
				query([
					{
						contactId: 'contact-1',
						eventType: 'contact.unsubscribed',
						occurredAt: '2026-10-02T00:00:00Z',
					},
					{
						contactId: 'contact-1',
						eventType: 'contact.resubscribed',
						occurredAt: '2026-10-03T00:00:00Z',
					},
				]),
			)
			.mockReturnValueOnce(query([]))
		expect(
			(await prepareDirectoryBirths([birth()], readDirectoryBirthStanding))[0]
				?.payload,
		).toMatchObject({ lifecycle: 'provisional' })
		expect(mocks.tags).toHaveBeenCalledTimes(1)
	})

	it.each(['not-found', 'failure'])(
		'fails closed on Kit %s',
		async (result) => {
			if (result === 'failure')
				mocks.tags.mockRejectedValue(new Error('Kit unavailable'))
			else mocks.tags.mockResolvedValue('not-found')
			await expect(
				prepareDirectoryBirths([birth()], readDirectoryBirthStanding),
			).rejects.toThrow()
		},
	)

	it('never lifts an already-stopped replay', async () => {
		const event = birth()
		;(event.payload as { lifecycle: string }).lifecycle = 'unsubscribed'
		expect(
			(
				await prepareDirectoryBirths(
					[event],
					async () => new Map([['contact-1', 'provisional']]),
				)
			)[0],
		).toEqual(event)
	})
})
