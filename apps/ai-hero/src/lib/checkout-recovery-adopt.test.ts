import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import {
	CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER,
	decideCheckoutRecoveryChargeAdoption,
	type CheckoutRecoveryChargeIdentity,
} from './checkout-recovery-adopt'

const incoming: CheckoutRecoveryChargeIdentity = {
	stripeChargeId: 'ch_recovery',
	userId: 'user_recovery',
	merchantAccountId: 'ma_recovery',
	merchantProductId: 'mp_recovery',
	merchantCustomerId: 'mcu_recovery',
}

const existingCharge = {
	id: 'mc_recovery',
	identifier: incoming.stripeChargeId,
	userId: incoming.userId,
	merchantAccountId: incoming.merchantAccountId,
	merchantProductId: incoming.merchantProductId,
	merchantCustomerId: incoming.merchantCustomerId,
}

describe('checkout recovery charge adoption', () => {
	it('creates when no charge exists and adopts a matching charge', () => {
		expect(
			decideCheckoutRecoveryChargeAdoption({
				existingCharge: null,
				existingPurchaseId: null,
				incoming,
			}),
		).toEqual({ action: 'create-charge' })

		expect(
			decideCheckoutRecoveryChargeAdoption({
				existingCharge,
				existingPurchaseId: null,
				incoming,
			}),
		).toEqual({ action: 'adopt-charge', merchantChargeId: 'mc_recovery' })
	})

	it('returns an existing Purchase only after identity matches', () => {
		expect(
			decideCheckoutRecoveryChargeAdoption({
				existingCharge,
				existingPurchaseId: 'purch_recovery',
				incoming,
			}),
		).toEqual({
			action: 'return-purchase',
			merchantChargeId: 'mc_recovery',
			purchaseId: 'purch_recovery',
		})
	})

	it.each([
		['identifier', 'ch_other'],
		['userId', 'user_other'],
		['merchantAccountId', 'ma_other'],
		['merchantProductId', 'mp_other'],
		['merchantCustomerId', 'mcu_other'],
	] as const)('rejects a mismatched %s before adoption', (key, value) => {
		expect(() =>
			decideCheckoutRecoveryChargeAdoption({
				existingCharge: { ...existingCharge, [key]: value },
				existingPurchaseId: null,
				incoming,
			}),
		).toThrow(CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER)
	})

	it('rejects a mismatch before returning an existing Purchase', () => {
		expect(() =>
			decideCheckoutRecoveryChargeAdoption({
				existingCharge: { ...existingCharge, userId: 'user_other' },
				existingPurchaseId: 'purch_other',
				incoming,
			}),
		).toThrow(CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER)
	})

	it('keeps the identity guard marker in the installed patched adapter', async () => {
		const require = createRequire(import.meta.url)
		const adapterEntry = require.resolve('@coursebuilder/adapter-drizzle/mysql')
		const installedAdapter = await readFile(adapterEntry, 'utf8')

		expect(installedAdapter).toContain(
			CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER,
		)
	})
})
