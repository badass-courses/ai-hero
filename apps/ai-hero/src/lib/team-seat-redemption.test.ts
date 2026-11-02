import { describe, expect, it, vi } from 'vitest'

import {
	addTeamSeatsByEmail,
	MAX_SEAT_EMAILS_PER_SUBMISSION,
	parseSeatEmails,
	type TeamSeatRedemptionDataSource,
} from './team-seat-redemption'
import {
	couponId,
	createFakeSeatDataSource,
	productId,
	purchaseId,
} from './team-seat-redemption.fixtures'

const add = (
	emails: string,
	dataSource: TeamSeatRedemptionDataSource,
	actorUserId = 'user-owner',
) => addTeamSeatsByEmail({ actorUserId, purchaseId, emails }, dataSource)

describe('parseSeatEmails', () => {
	it('lowercases, splits on commas, semicolons and whitespace, and drops duplicates', () => {
		expect(
			parseSeatEmails(
				'A@Example.com, b@example.com;\n a@example.com\t<c@example.com> nope',
			),
		).toEqual({
			emails: ['a@example.com', 'b@example.com', 'c@example.com'],
			invalid: ['nope'],
		})
	})
})

describe('addTeamSeatsByEmail', () => {
	it('refuses an organization member without a manager role', async () => {
		const { dataSource } = createFakeSeatDataSource({
			seats: 5,
			roles: { 'user-learner': ['learner'] },
		})
		await expect(
			add('a@example.com', dataSource, 'user-learner'),
		).rejects.toMatchObject({ code: 'forbidden' })
		expect(dataSource.redeemFullPriceCoupon).not.toHaveBeenCalled()
	})

	it('refuses someone outside the organization and an unknown purchase', async () => {
		const { dataSource } = createFakeSeatDataSource({ seats: 5 })
		await expect(
			add('a@example.com', dataSource, 'user-stranger'),
		).rejects.toMatchObject({ code: 'forbidden' })
		await expect(
			addTeamSeatsByEmail(
				{
					actorUserId: 'user-owner',
					purchaseId: 'purchase-other',
					emails: 'a@example.com',
				},
				dataSource,
			),
		).rejects.toMatchObject({ code: 'forbidden' })
		expect(dataSource.redeemFullPriceCoupon).not.toHaveBeenCalled()
	})

	it('lets a billing admin add seats', async () => {
		const { dataSource } = createFakeSeatDataSource({
			seats: 5,
			roles: { 'user-admin': ['billing_admin'] },
		})
		const { addedCount } = await add('a@example.com', dataSource, 'user-admin')
		expect(addedCount).toBe(1)
	})

	it('refuses a refunded purchase', async () => {
		const { dataSource } = createFakeSeatDataSource({
			seats: 5,
			purchaseStatus: 'Refunded',
		})
		await expect(add('a@example.com', dataSource)).rejects.toMatchObject({
			code: 'forbidden',
		})
	})

	it('caps a submission at 50 addresses before taking any seat', async () => {
		const { dataSource } = createFakeSeatDataSource({ seats: 100 })
		const emails = Array.from(
			{ length: MAX_SEAT_EMAILS_PER_SUBMISSION + 1 },
			(_, index) => `learner${index}@example.com`,
		).join('\n')
		await expect(add(emails, dataSource)).rejects.toMatchObject({
			code: 'invalid-email',
		})
		expect(dataSource.redeemFullPriceCoupon).not.toHaveBeenCalled()
	})

	it('caps at the free seats and reports the rest as no seats left', async () => {
		const { dataSource, coupon } = createFakeSeatDataSource({
			seats: 5,
			usedCount: 3,
		})
		const { results, addedCount } = await add(
			'a@example.com b@example.com c@example.com d@example.com',
			dataSource,
		)
		expect(results).toEqual([
			{ email: 'a@example.com', status: 'added' },
			{ email: 'b@example.com', status: 'added' },
			{ email: 'c@example.com', status: 'no-seats-left' },
			{ email: 'd@example.com', status: 'no-seats-left' },
		])
		expect(addedCount).toBe(2)
		expect(coupon.usedCount).toBe(5)
		expect(dataSource.redeemFullPriceCoupon).toHaveBeenCalledTimes(2)
	})

	it('takes one seat per address however often it is pasted', async () => {
		const { dataSource, coupon } = createFakeSeatDataSource({ seats: 5 })
		const { results } = await add(
			'a@example.com, A@EXAMPLE.COM\na@example.com',
			dataSource,
		)
		expect(results).toEqual([{ email: 'a@example.com', status: 'added' }])
		expect(coupon.usedCount).toBe(1)
	})

	it('skips anyone who already owns the product without taking a seat', async () => {
		const { dataSource, coupon } = createFakeSeatDataSource({
			seats: 5,
			owners: ['owner@example.com'],
		})
		const { results } = await add(
			'owner@example.com new@example.com',
			dataSource,
		)
		expect(results).toEqual([
			{ email: 'owner@example.com', status: 'already-had-access' },
			{ email: 'new@example.com', status: 'added' },
		])
		expect(coupon.usedCount).toBe(1)
		expect(dataSource.redeemFullPriceCoupon).toHaveBeenCalledTimes(1)
	})

	it('maps an adapter duplicate-seat refusal to already had access', async () => {
		const { dataSource, coupon } = createFakeSeatDataSource({
			seats: 5,
			adapterError: {
				'seat@example.com': 'team-seat-redemption-already-claimed',
				'bought@example.com': 'already-purchased-bought@example.com',
			},
		})
		const { results } = await add(
			'seat@example.com bought@example.com',
			dataSource,
		)
		expect(results.map(({ status }) => status)).toEqual([
			'already-had-access',
			'already-had-access',
		])
		expect(coupon.usedCount).toBe(0)
	})

	it('stops when the coupon runs out under a concurrent claim', async () => {
		const { dataSource, coupon } = createFakeSeatDataSource({ seats: 3 })
		// Another learner claims through the invite link after the seat count
		// is read: the adapter stops validating at the third address.
		vi.mocked(dataSource.redeemFullPriceCoupon).mockImplementationOnce(
			async ({ email }) => {
				coupon.usedCount = 2
				return {
					purchase: {
						id: `seat-${email}`,
						userId: `user-${email}`,
						productId,
						redeemedBulkCouponId: couponId,
					},
					redeemingForCurrentUser: false,
				}
			},
		)
		const { results } = await add(
			'a@example.com b@example.com c@example.com',
			dataSource,
		)
		expect(results).toEqual([
			{ email: 'a@example.com', status: 'added' },
			{ email: 'b@example.com', status: 'added' },
			{ email: 'c@example.com', status: 'no-seats-left' },
		])
		expect(dataSource.redeemFullPriceCoupon).toHaveBeenCalledTimes(3)
		expect(coupon.usedCount).toBe(3)
	})

	it('sends the seat follow-up for each added learner and reports a failed one', async () => {
		const { dataSource } = createFakeSeatDataSource({
			seats: 5,
			failFollowUpFor: ['b@example.com'],
		})
		const { results, addedCount } = await add(
			'a@example.com b@example.com',
			dataSource,
		)
		expect(dataSource.afterSeatRedeemed).toHaveBeenCalledTimes(2)
		expect(results[1]).toEqual({
			email: 'b@example.com',
			status: 'added-email-failed',
		})
		expect(addedCount).toBe(2)
	})

	it('passes an existing account as the current user, as Course Builder redeem does', async () => {
		const { dataSource } = createFakeSeatDataSource({ seats: 5 })
		vi.mocked(dataSource.findUserIdByEmail).mockResolvedValueOnce('user-known')
		await add('known@example.com', dataSource)
		expect(dataSource.redeemFullPriceCoupon).toHaveBeenCalledWith({
			email: 'known@example.com',
			couponId,
			productIds: [productId],
			currentUserId: 'user-known',
			redeemingProductId: productId,
		})
	})

	it('reports invalid entries after the processed addresses', async () => {
		const { dataSource } = createFakeSeatDataSource({ seats: 5 })
		const { results } = await add('not-an-email a@example.com', dataSource)
		expect(results).toEqual([
			{ email: 'a@example.com', status: 'added' },
			{ email: 'not-an-email', status: 'invalid' },
		])
	})
})
