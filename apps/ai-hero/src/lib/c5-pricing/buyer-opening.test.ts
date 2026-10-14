import { describe, expect, it } from 'vitest'
import { c5BuyerOpening, type BuyerOpeningInput } from './buyer-opening'
import { C5_PRODUCT_ID } from './products'
import { AUTHORITATIVE_CLOSE_BUFFER_MS } from '@coursebuilder/commerce/authoritative-price'

const base: BuyerOpeningInput = {
	switchEnabled: false,
	overrideDisabled: false,
	now: 0,
	window: { opensAt: 100, checkoutStopsAt: 10000, closesAt: 2000000 },
	gift: {
		verified: true,
		productId: C5_PRODUCT_ID,
		code: {
			codeRef: 'fixture',
			unitPrice: 40000,
			expiresAt: new Date(3000000).toISOString(),
			usesTaken: 0,
			maxUses: 5,
		},
	},
}

describe('C5 opening for this buyer', () => {
	it('ends at either creation or enrollment close, even if the other clock is later', () => {
		for (const key of ['checkoutStopsAt', 'closesAt'] as const) {
			const window = {
				opensAt: null,
				checkoutStopsAt: 9_000_000,
				closesAt: 9_000_000,
				[key]: 2_000_000,
			}
			for (const switchEnabled of [false, true])
				expect(
					c5BuyerOpening({ ...base, switchEnabled, now: 2_000_000, window }),
				).toBe('closed')
		}
	})
	it('requires the whole provider lifetime, including the exact boundary', () => {
		for (const remaining of [
			AUTHORITATIVE_CLOSE_BUFFER_MS - 1,
			AUTHORITATIVE_CLOSE_BUFFER_MS,
			AUTHORITATIVE_CLOSE_BUFFER_MS + 1,
		]) {
			const gift = {
				...base.gift!,
				code: {
					...base.gift!.code,
					expiresAt: new Date(remaining).toISOString(),
				},
			}
			expect(c5BuyerOpening({ ...base, gift })).toBe(
				remaining >= AUTHORITATIVE_CLOSE_BUFFER_MS ? 'gift' : 'closed',
			)
		}
	})
	it('opens early only for a server-verified, usable gift, across the state space', () => {
		for (const switchEnabled of [false, true])
			for (const overrideDisabled of [false, true])
				for (const now of [-1000, 0, 99, 100, 101, 9999, 10000, 2000000])
					for (const state of [
						'valid',
						'expired',
						'exhausted',
						'absent',
						'forged',
						'other-product',
						'cookie-only',
					] as const) {
						const gift =
							state === 'absent' || state === 'cookie-only'
								? null
								: {
										...base.gift!,
										verified: state !== 'forged',
										productId:
											state === 'other-product'
												? 'fixture-other'
												: C5_PRODUCT_ID,
										code: {
											...base.gift!.code,
											expiresAt: new Date(
												state === 'expired' ? now : 3000000,
											).toISOString(),
											usesTaken: state === 'exhausted' ? 5 : 0,
										},
									}
						const actual = c5BuyerOpening({
							...base,
							switchEnabled,
							overrideDisabled,
							now,
							gift,
						})
						const standard = switchEnabled && now >= 100
						const open =
							!overrideDisabled &&
							now < 10000 &&
							(standard || state === 'valid')
						expect(
							actual,
							JSON.stringify({ switchEnabled, overrideDisabled, now, state }),
						).toBe(open ? (standard ? 'standard' : 'gift') : 'closed')
					}
	})
	it('fails closed on missing or malformed windows and insufficient session lifetime', () => {
		for (const window of [
			null,
			{ ...base.window!, closesAt: NaN },
			{ ...base.window!, opensAt: NaN },
			{ ...base.window!, closesAt: 1000 },
		])
			expect(c5BuyerOpening({ ...base, window })).toBe('closed')
	})
})
