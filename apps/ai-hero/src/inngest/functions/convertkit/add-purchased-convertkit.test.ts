import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findUser: vi.fn(),
	findPurchase: vi.fn(),
	getPrimarySubscriber: vi.fn(),
	updatePrimarySubscriber: vi.fn(),
	getTtSubscriber: vi.fn(),
	updateTtSubscriber: vi.fn(),
	createPurchaserTagger: vi.fn(),
	getRequiredKitV4ApiKey: vi.fn(),
	tagExistingSubscriber: vi.fn(),
	createFunction: vi.fn(),
	log: {
		debug: vi.fn(),
		info: vi.fn(),
	},
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriberByEmail: mocks.getPrimarySubscriber,
		updateSubscriberFields: mocks.updatePrimarySubscriber,
	},
}))

vi.mock('@/coursebuilder/crash-course-purchaser-kit-v4', () => ({
	createCrashCoursePurchaserTagger: mocks.createPurchaserTagger,
	getRequiredKitV4ApiKey: mocks.getRequiredKitV4ApiKey,
}))

vi.mock('@/coursebuilder/tt-convertkit-provider', () => ({
	ttConvertkitProvider: {
		getSubscriberByEmail: mocks.getTtSubscriber,
		updateSubscriberFields: mocks.updateTtSubscriber,
	},
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			users: { findFirst: mocks.findUser },
			purchases: { findFirst: mocks.findPurchase },
		},
	},
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: mocks.createFunction.mockImplementation(
			(config: unknown, _trigger: unknown, handler: unknown) => ({
				config,
				handler,
			}),
		),
	},
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('date-fns', () => ({ format: vi.fn(() => 'purchase-date') }))

import { addPurchasesConvertkit } from './add-purchased-convertkit'

type TestHandler = (args: {
	event: {
		user: { id: string; email: string }
		data: { purchaseId: string }
	}
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
	}
}) => Promise<unknown>

const fn = addPurchasesConvertkit as unknown as {
	config: { idempotency: string }
	handler: TestHandler
}
const handler = fn.handler

const event = {
	user: { id: 'user-1', email: 'buyer@example.com' },
	data: { purchaseId: 'purchase-1' },
}

function createStep() {
	return {
		run: vi.fn(async (_id: string, callback: () => Promise<unknown>) =>
			callback(),
		),
	}
}

function purchase(productId: string, slug = 'ai-coding-crash-course') {
	return {
		id: 'purchase-1',
		productId,
		createdAt: new Date('2026-08-15T12:00:00.000Z'),
		product: { fields: { slug } },
	}
}

describe('addPurchasesConvertkit', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findUser.mockResolvedValue({
			id: 'user-1',
			email: 'buyer@example.com',
		})
		mocks.findPurchase.mockResolvedValue(purchase('product-ma254'))
		mocks.getPrimarySubscriber.mockResolvedValue({ id: 'primary-41' })
		mocks.updatePrimarySubscriber.mockResolvedValue(undefined)
		mocks.getTtSubscriber.mockResolvedValue({ id: 'tt-42' })
		mocks.updateTtSubscriber.mockResolvedValue(undefined)
		mocks.getRequiredKitV4ApiKey.mockReturnValue('kit-v4-key')
		mocks.createPurchaserTagger.mockReturnValue(mocks.tagExistingSubscriber)
		mocks.tagExistingSubscriber.mockResolvedValue({
			subscriberId: 'primary-41',
		})
		mocks.log.debug.mockResolvedValue(undefined)
		mocks.log.info.mockResolvedValue(undefined)
	})

	it('uses the purchase id as its idempotency key', () => {
		expect(fn.config.idempotency).toBe('event.data.purchaseId')
	})

	it('keeps the canonical property and v4-tags a Crash Course purchaser', async () => {
		await handler({ event, step: createStep() })

		expect(mocks.updatePrimarySubscriber).toHaveBeenCalledWith({
			subscriberId: 'primary-41',
			fields: {
				purchased_ai_coding_crash_course_on: 'purchase-date',
			},
		})
		expect(mocks.createPurchaserTagger).toHaveBeenCalledWith({
			apiKey: 'kit-v4-key',
		})
		expect(mocks.tagExistingSubscriber).toHaveBeenCalledWith('primary-41')
		expect(mocks.updateTtSubscriber).toHaveBeenCalledOnce()
	})

	it('hard-codes the primary field when the Crash Course slug changes', async () => {
		mocks.findPurchase.mockResolvedValue(
			purchase('product-ma254', 'renamed-crash-course'),
		)

		await handler({ event, step: createStep() })

		expect(mocks.updatePrimarySubscriber).toHaveBeenCalledWith({
			subscriberId: 'primary-41',
			fields: {
				purchased_ai_coding_crash_course_on: 'purchase-date',
			},
		})
		expect(mocks.tagExistingSubscriber).toHaveBeenCalledWith('primary-41')
		expect(mocks.updateTtSubscriber).toHaveBeenCalledWith({
			subscriberId: 'tt-42',
			fields: {
				purchased_renamed_crash_course_on: 'purchase-date',
			},
		})
	})

	it('does not tag another product even if its slug matches', async () => {
		mocks.findPurchase.mockResolvedValue(purchase('product-other'))

		await handler({ event, step: createStep() })

		expect(mocks.updatePrimarySubscriber).toHaveBeenCalledOnce()
		expect(mocks.tagExistingSubscriber).not.toHaveBeenCalled()
	})

	it('does not write or create a primary subscriber when lookup misses', async () => {
		mocks.getPrimarySubscriber.mockResolvedValue(null)

		await handler({ event, step: createStep() })

		expect(mocks.updatePrimarySubscriber).not.toHaveBeenCalled()
		expect(mocks.tagExistingSubscriber).not.toHaveBeenCalled()
		expect(mocks.updateTtSubscriber).toHaveBeenCalledOnce()
	})
})
