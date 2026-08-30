import { describe, expect, it } from 'vitest'

import { courseBuilderCoreFunctions } from '@coursebuilder/core/inngest'

/**
 * Behavioral proof for AIH-254 against the installed (patched)
 * @coursebuilder/core checkout-session-completed handler: a verified
 * signed-in checkout (metadata.userId stamped at session creation) keeps that
 * user as the canonical purchase owner even when the Stripe billing/contact
 * email differs. No temporary owner account is created and retries do not
 * duplicate the purchase.
 */

type StubUser = { id: string; email: string; name?: string | null }

function createDbStub({ users = [] }: { users?: StubUser[] } = {}) {
	const usersById = new Map(users.map((user) => [user.id, user]))
	const usersByEmail = new Map(
		users.map((user) => [user.email.toLowerCase(), user]),
	)
	const purchasesByCharge = new Map<string, { id: string; userId: string }>()
	const calls = {
		findOrCreateUser: [] as string[],
		getUserById: [] as string[],
	}
	let userSequence = 0
	let purchaseSequence = 0

	const db = {
		getMerchantAccount: async () => ({ id: 'ma_1' }),
		getUserById: async (id: string) => {
			calls.getUserById.push(id)
			return usersById.get(id) ?? null
		},
		getUserByEmail: async (email: string | null) =>
			(email && usersByEmail.get(email.toLowerCase())) || null,
		findOrCreateUser: async (email: string) => {
			calls.findOrCreateUser.push(email)
			const existing = usersByEmail.get(email.toLowerCase())
			if (existing) return { user: existing, isNewUser: false }
			const user = { id: `user_created_${++userSequence}`, email }
			usersById.set(user.id, user)
			usersByEmail.set(email.toLowerCase(), user)
			return { user, isNewUser: true }
		},
		getPurchaseForStripeCharge: async () => null,
		getPurchasesForUser: async () => [],
		getMerchantProduct: async () => ({ id: 'mp_1', productId: 'prod_1' }),
		findOrCreateMerchantCustomer: async ({ user }: { user: StubUser }) => ({
			id: 'mcu_1',
			userId: user.id,
		}),
		getProduct: async () => ({
			id: 'prod_1',
			name: 'AI Hero',
			type: 'self-paced',
		}),
		// Mirrors the patched adapter-drizzle charge-identity guard: the same
		// Stripe charge returns the existing Purchase when the identity matches
		// and refuses a conflicting owner.
		createMerchantChargeAndPurchase: async (input: {
			stripeChargeId: string
			userId: string
		}) => {
			const existing = purchasesByCharge.get(input.stripeChargeId)
			if (existing) {
				if (existing.userId !== input.userId) {
					throw new Error(
						'CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_V1: existing merchant charge does not match checkout',
					)
				}
				return { ...existing, fields: {} }
			}
			const purchase = {
				id: `purch_${++purchaseSequence}`,
				userId: input.userId,
			}
			purchasesByCharge.set(input.stripeChargeId, purchase)
			return { ...purchase, fields: {} }
		},
	}

	return { db, calls, purchasesByCharge, usersByEmail }
}

function buildStripeEvent() {
	return {
		id: 'evt_aih254',
		created: 1_700_000_000,
		type: 'checkout.session.completed',
		data: {
			object: {
				id: 'cs_test_aih254',
				object: 'checkout.session',
				amount_subtotal: 19_900,
				amount_total: 19_900,
				created: 1_700_000_000,
				currency: 'usd',
				custom_fields: [],
				customer: 'cus_aih254',
				customer_details: {
					address: null,
					email: 'billing@corporate-card.example.com',
					name: 'Card Holder',
				},
				livemode: false,
				metadata: {},
				mode: 'payment',
				payment_intent: 'pi_aih254',
				payment_method_collection: 'always',
				payment_status: 'paid',
				phone_number_collection: { enabled: false },
				status: 'complete',
				subscription: null,
				success_url: 'https://www.aihero.dev/thanks/purchase',
				total_details: {
					amount_discount: 0,
					amount_shipping: 0,
					amount_tax: 0,
				},
			},
		},
	}
}

function buildExpandedCheckoutSession({
	billingEmail,
	metadataUserId,
}: {
	billingEmail: string
	metadataUserId?: string
}) {
	return {
		id: 'cs_test_aih254',
		metadata: {
			productId: 'prod_1',
			product: 'AI Hero',
			bulk: 'false',
			country: 'US',
			ip_address: '',
			...(metadataUserId && { userId: metadataUserId }),
		},
		customer: {
			id: 'cus_aih254',
			email: billingEmail,
			name: 'Card Holder',
		},
		line_items: {
			data: [
				{
					price: {
						id: 'price_1',
						product: { id: 'stripe_prod_1', name: 'AI Hero' },
					},
					quantity: 1,
					discounts: [],
				},
			],
		},
		payment_intent: {
			id: 'pi_aih254',
			amount_received: 19_900,
			latest_charge: { id: 'ch_aih254', amount: 19_900 },
		},
		amount_total: 19_900,
	}
}

function getCheckoutCompletedHandler() {
	const fn = courseBuilderCoreFunctions.find(
		(candidate) => candidate.config.id === 'stripe-checkout-session-completed',
	)
	if (!fn) throw new Error('stripe-checkout-session-completed not found')
	return fn.handler as (input: unknown) => Promise<{
		purchase: { id: string; userId: string }
		purchaseInfo: { email: string | null }
	}>
}

async function runCheckoutCompleted({
	db,
	billingEmail,
	metadataUserId,
}: {
	db: unknown
	billingEmail: string
	metadataUserId?: string
}) {
	const handler = getCheckoutCompletedHandler()
	const step = {
		run: async (_name: string, fn: () => Promise<unknown>) => fn(),
		sendEvent: async () => undefined,
	}
	const paymentProvider = {
		options: {
			paymentsAdapter: {
				getCheckoutSession: async () =>
					buildExpandedCheckoutSession({ billingEmail, metadataUserId }),
			},
		},
	}

	return handler({
		event: { data: { stripeEvent: buildStripeEvent() } },
		step,
		db,
		siteRootUrl: 'https://www.aihero.dev',
		paymentProvider,
		emailProvider: {},
		getAuthConfig: () => ({}),
		notificationProvider: undefined,
	})
}

const accountUser: StubUser = {
	id: 'user_account',
	email: 'account@example.com',
}

describe('stripe-checkout-session-completed owner resolution (patched core)', () => {
	it('keeps the signed-in user as owner when the billing email matches', async () => {
		const { db, calls } = createDbStub({ users: [accountUser] })

		const result = await runCheckoutCompleted({
			db,
			billingEmail: accountUser.email,
			metadataUserId: accountUser.id,
		})

		expect(result.purchase.userId).toBe(accountUser.id)
		expect(calls.findOrCreateUser).toEqual([])
	})

	it('keeps the signed-in user as owner when the billing email differs, without a temporary owner', async () => {
		const { db, calls, usersByEmail } = createDbStub({ users: [accountUser] })

		const result = await runCheckoutCompleted({
			db,
			billingEmail: 'billing@corporate-card.example.com',
			metadataUserId: accountUser.id,
		})

		expect(result.purchase.userId).toBe(accountUser.id)
		expect(calls.findOrCreateUser).toEqual([])
		expect(usersByEmail.has('billing@corporate-card.example.com')).toBe(false)
	})

	it('resolves an anonymous checkout to the existing account for that email', async () => {
		const { db, calls } = createDbStub({ users: [accountUser] })

		const result = await runCheckoutCompleted({
			db,
			billingEmail: accountUser.email,
		})

		expect(result.purchase.userId).toBe(accountUser.id)
		expect(calls.findOrCreateUser).toEqual([accountUser.email])
	})

	it('creates a new user for an anonymous checkout with an unknown email', async () => {
		const { db, calls, usersByEmail } = createDbStub()

		const result = await runCheckoutCompleted({
			db,
			billingEmail: 'new-buyer@example.com',
		})

		expect(usersByEmail.has('new-buyer@example.com')).toBe(true)
		expect(result.purchase.userId).toBe(
			usersByEmail.get('new-buyer@example.com')!.id,
		)
		expect(calls.findOrCreateUser).toEqual(['new-buyer@example.com'])
	})

	it('falls back to the billing email when the metadata user no longer exists', async () => {
		const { db, calls } = createDbStub()

		const result = await runCheckoutCompleted({
			db,
			billingEmail: 'buyer@example.com',
			metadataUserId: 'user_deleted',
		})

		expect(calls.getUserById).toContain('user_deleted')
		expect(calls.findOrCreateUser).toEqual(['buyer@example.com'])
		expect(result.purchase.userId).not.toBe('user_deleted')
	})

	it('retries deterministically without duplicating the purchase or the owner', async () => {
		const { db, calls, purchasesByCharge } = createDbStub({
			users: [accountUser],
		})

		const first = await runCheckoutCompleted({
			db,
			billingEmail: 'billing@corporate-card.example.com',
			metadataUserId: accountUser.id,
		})
		const second = await runCheckoutCompleted({
			db,
			billingEmail: 'billing@corporate-card.example.com',
			metadataUserId: accountUser.id,
		})

		expect(second.purchase.id).toBe(first.purchase.id)
		expect(second.purchase.userId).toBe(accountUser.id)
		expect(purchasesByCharge.size).toBe(1)
		expect(calls.findOrCreateUser).toEqual([])
	})
})
