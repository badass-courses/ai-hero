import { describe, expect, it, vi } from 'vitest'

import {
	AI_CODING_CRASH_COURSE_PRODUCT_ID,
	AI_CODING_CRASH_COURSE_PURCHASED_ON_FIELD,
	AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID,
	AI_CODING_CRASH_COURSE_PURCHASER_TAG,
	AI_CODING_CRASH_COURSE_SLUG,
	ACTIVE_PURCHASE_STATUSES,
	formatKitPurchaseDate,
	isAiCodingCrashCoursePurchase,
	projectExistingCrashCoursePurchasers,
} from './crash-course-purchaser-tag'

describe('AI Coding Crash Course purchaser tag', () => {
	it('uses the fixed product and tag contract', () => {
		expect(AI_CODING_CRASH_COURSE_PRODUCT_ID).toBe('product-ma254')
		expect(AI_CODING_CRASH_COURSE_SLUG).toBe('ai-coding-crash-course')
		expect(AI_CODING_CRASH_COURSE_PURCHASED_ON_FIELD).toBe(
			'purchased_ai_coding_crash_course_on',
		)
		expect(AI_CODING_CRASH_COURSE_PURCHASER_TAG_ID).toBe('22490749')
		expect(AI_CODING_CRASH_COURSE_PURCHASER_TAG).toBe(
			'AI Coding Crash Course Purchaser',
		)
		expect(ACTIVE_PURCHASE_STATUSES).toEqual(['Valid', 'Restricted'])
		expect(isAiCodingCrashCoursePurchase('product-ma254')).toBe(true)
		expect(isAiCodingCrashCoursePurchase('product-other')).toBe(false)
	})

	it('looks up unique existing subscribers without writing in dry-run mode', async () => {
		const purchasedAt = new Date('2026-08-15T12:00:00.000Z')
		const getSubscriberByEmail = vi
			.fn()
			.mockResolvedValueOnce({ id: 41 })
			.mockResolvedValueOnce(null)
		const updateSubscriberFields = vi.fn()
		const tagExistingSubscriber = vi.fn()

		const result = await projectExistingCrashCoursePurchasers({
			candidates: [
				{ email: ' Buyer@example.com ', purchasedAt },
				{
					email: 'buyer@example.com',
					purchasedAt: new Date('2026-08-16T12:00:00.000Z'),
				},
				{ email: 'missing@example.com', purchasedAt },
				{ email: null, purchasedAt },
			],
			allowWrite: false,
			provider: { getSubscriberByEmail, updateSubscriberFields },
			tagExistingSubscriber,
		})

		expect(getSubscriberByEmail).toHaveBeenCalledTimes(2)
		expect(updateSubscriberFields).not.toHaveBeenCalled()
		expect(tagExistingSubscriber).not.toHaveBeenCalled()
		expect(result).toEqual({
			mode: 'dry-run',
			counts: {
				purchasesScanned: 4,
				uniquePurchasers: 2,
				invalidPurchasers: 1,
				matchedSubscribers: 1,
				missingSubscribers: 1,
				lookupFailures: 0,
				plannedPropertyWrites: 1,
				plannedTagWrites: 1,
				propertyWrites: 0,
				propertyFailures: 0,
				tagWrites: 0,
				tagFailures: 0,
			},
		})
	})

	it('requires explicit write capability before any write-mode lookup', async () => {
		const getSubscriberByEmail = vi.fn()

		await expect(
			projectExistingCrashCoursePurchasers({
				candidates: [
					{
						email: 'buyer@example.com',
						purchasedAt: new Date('2026-08-15T12:00:00.000Z'),
					},
				],
				allowWrite: true,
				provider: { getSubscriberByEmail },
			}),
		).rejects.toThrow('Kit purchaser projection writes are unavailable')
		expect(getSubscriberByEmail).not.toHaveBeenCalled()
	})

	it('writes the canonical property then tags only matched subscribers', async () => {
		const purchasedAt = new Date('2026-08-15T12:00:00.000Z')
		const getSubscriberByEmail = vi
			.fn()
			.mockResolvedValueOnce({ id: 41 })
			.mockResolvedValueOnce(null)
		const updateSubscriberFields = vi.fn().mockResolvedValue({ id: 41 })
		const tagExistingSubscriber = vi.fn().mockResolvedValue({
			subscriberId: '41',
		})

		const result = await projectExistingCrashCoursePurchasers({
			candidates: [
				{ email: 'buyer@example.com', purchasedAt },
				{ email: 'missing@example.com', purchasedAt },
			],
			allowWrite: true,
			provider: { getSubscriberByEmail, updateSubscriberFields },
			tagExistingSubscriber,
		})

		expect(updateSubscriberFields).toHaveBeenCalledWith({
			subscriberId: '41',
			fields: {
				purchased_ai_coding_crash_course_on: formatKitPurchaseDate(purchasedAt),
			},
		})
		expect(tagExistingSubscriber).toHaveBeenCalledWith('41')
		const propertyWriteOrder =
			updateSubscriberFields.mock.invocationCallOrder[0]
		const tagWriteOrder = tagExistingSubscriber.mock.invocationCallOrder[0]
		if (propertyWriteOrder === undefined || tagWriteOrder === undefined) {
			throw new Error('Expected both purchaser projection writes')
		}
		expect(propertyWriteOrder).toBeLessThan(tagWriteOrder)
		expect(result.mode).toBe('allow-write')
		expect(result.counts).toMatchObject({
			matchedSubscribers: 1,
			missingSubscribers: 1,
			plannedPropertyWrites: 1,
			plannedTagWrites: 1,
			propertyWrites: 1,
			tagWrites: 1,
		})
	})

	it('counts a property failure and does not attach the companion tag', async () => {
		const tagExistingSubscriber = vi.fn()
		const result = await projectExistingCrashCoursePurchasers({
			candidates: [
				{
					email: 'buyer@example.com',
					purchasedAt: new Date('2026-08-15T12:00:00.000Z'),
				},
			],
			allowWrite: true,
			provider: {
				getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 41 }),
				updateSubscriberFields: vi
					.fn()
					.mockRejectedValue(new Error('field failed')),
			},
			tagExistingSubscriber,
		})

		expect(result.counts.propertyFailures).toBe(1)
		expect(result.counts.propertyWrites).toBe(0)
		expect(tagExistingSubscriber).not.toHaveBeenCalled()
	})

	it('counts a tag failure after the canonical property succeeds', async () => {
		const result = await projectExistingCrashCoursePurchasers({
			candidates: [
				{
					email: 'buyer@example.com',
					purchasedAt: new Date('2026-08-15T12:00:00.000Z'),
				},
			],
			allowWrite: true,
			provider: {
				getSubscriberByEmail: vi.fn().mockResolvedValue({ id: 41 }),
				updateSubscriberFields: vi.fn().mockResolvedValue({ id: 41 }),
			},
			tagExistingSubscriber: vi.fn().mockRejectedValue(new Error('tag failed')),
		})

		expect(result.counts.propertyWrites).toBe(1)
		expect(result.counts.tagFailures).toBe(1)
		expect(result.counts.tagWrites).toBe(0)
	})
})
