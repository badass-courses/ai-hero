/**
 * Invariant tests for the purchase-transfer server actions (AIH-223 /
 * AIH-209): source/target ownership, expiry, replay idempotency, double
 * accept/cancel, compare-and-swap races, and Inngest publish failure
 * leaving a durable, visible outbox record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getServerAuthSession: vi.fn(),
	getPurchaseUserTransferById: vi.fn(),
	getUserById: vi.fn(),
	findOrCreateUser: vi.fn(),
	purchasesFindFirst: vi.fn(),
	putFindMany: vi.fn(),
	putFindFirst: vi.fn(),
	outboxFindMany: vi.fn(),
	stripeGetCustomer: vi.fn(),
	stripeUpdateCustomer: vi.fn(),
	sendServerEmail: vi.fn(),
	inngestSend: vi.fn(),
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	dbState: {
		updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
		inserts: [] as Array<{
			table: unknown
			values: Record<string, unknown>
			upsert: boolean
		}>,
		// Decides affectedRows per update call, in call order. May throw to
		// simulate a database failure at that exact write.
		updateHandler: (_call: {
			table: unknown
			values: Record<string, unknown>
		}): number => 1,
	},
}))

function executor() {
	return {
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async (_where: unknown) => {
					const call = { table, values }
					mocks.dbState.updates.push(call)
					return [{ affectedRows: mocks.dbState.updateHandler(call) }]
				},
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				const call = { table, values, upsert: false }
				mocks.dbState.inserts.push(call)
				return {
					onDuplicateKeyUpdate: async (_config: unknown) => {
						call.upsert = true
					},
					then: (
						resolve: (value?: unknown) => unknown,
						reject?: (reason?: unknown) => unknown,
					) => Promise.resolve(undefined).then(resolve, reject),
				}
			},
		}),
	}
}

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getPurchaseUserTransferById: mocks.getPurchaseUserTransferById,
		getUserById: mocks.getUserById,
		findOrCreateUser: mocks.findOrCreateUser,
	},
	db: {
		...executor(),
		transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn(executor()),
		query: {
			purchases: { findFirst: mocks.purchasesFindFirst },
			purchaseUserTransfer: {
				findMany: mocks.putFindMany,
				findFirst: mocks.putFindFirst,
			},
			purchaseTransferOutbox: { findMany: mocks.outboxFindMany },
		},
	},
}))

vi.mock('@/env.mjs', () => ({
	env: {
		COURSEBUILDER_URL: 'https://coursebuilder.example.com',
		NEXT_PUBLIC_URL: 'https://aihero.example.com',
	},
}))
vi.mock('@/server/auth', () => ({
	authOptions: {},
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/coursebuilder/email-provider', () => ({ emailProvider: {} }))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		getCustomer: mocks.stripeGetCustomer,
		updateCustomer: mocks.stripeUpdateCustomer,
	},
}))
vi.mock('@coursebuilder/core/lib/send-server-email', () => ({
	sendServerEmail: mocks.sendServerEmail,
}))
vi.mock('@coursebuilder/email-templates/emails/purchase-transfer', () => ({
	default: vi.fn(),
}))
vi.mock('@react-email/render', () => ({ render: vi.fn(async () => '') }))
vi.mock('inngest', () => ({
	Inngest: class {
		send = mocks.inngestSend
	},
}))

import {
	merchantCharge,
	merchantCustomer,
	purchases as purchaseTable,
	purchaseTransferOutbox,
	purchaseUserTransfer as purchaseUserTransferTable,
} from '@/db/schema'

import {
	acceptPurchaseTransfer,
	cancelPurchaseTransfer,
	getPurchaseTransferForPurchaseId,
	initiatePurchaseTransfer,
} from './purchase-transfer-actions'

const FUTURE = new Date('2027-01-01T00:00:00.000Z')
const PAST = new Date('2020-01-01T00:00:00.000Z')

const transferRow = (overrides: Record<string, unknown> = {}) => ({
	id: 'put_1',
	transferState: 'AVAILABLE',
	purchaseId: 'purchase_1',
	sourceUserId: 'user_a',
	targetUserId: null,
	createdAt: PAST,
	expiresAt: FUTURE,
	canceledAt: null,
	confirmedAt: null,
	completedAt: null,
	...overrides,
})

const purchaseRow = (overrides: Record<string, unknown> = {}) => ({
	id: 'purchase_1',
	userId: 'user_a',
	organizationId: 'org_a',
	merchantCharge: {
		id: 'mch_1',
		merchantCustomerId: 'mcu_1',
		merchantCustomer: { id: 'mcu_1', identifier: 'cus_stripe_1' },
	},
	...overrides,
})

const sessionFor = (user: { id: string; email: string } | null) => ({
	session: user ? { user } : null,
})

const updatesFor = (table: unknown) =>
	mocks.dbState.updates.filter((u) => u.table === table)
const insertsFor = (table: unknown) =>
	mocks.dbState.inserts.filter((u) => u.table === table)

beforeEach(() => {
	vi.clearAllMocks()
	mocks.dbState.updates = []
	mocks.dbState.inserts = []
	mocks.dbState.updateHandler = () => 1
	mocks.putFindMany.mockResolvedValue([])
	mocks.putFindFirst.mockResolvedValue(transferRow())
	// The publish loop reads unpublished outbox rows after the transaction;
	// reflect whatever the action inserted, as PENDING, like the real table.
	mocks.outboxFindMany.mockImplementation(async () =>
		insertsFor(purchaseTransferOutbox).map((insert) => ({
			id: insert.values.id as string,
			status: 'PENDING',
		})),
	)
	mocks.purchasesFindFirst.mockResolvedValue(purchaseRow())
	mocks.stripeGetCustomer.mockResolvedValue({ name: 'Old Name' })
	mocks.stripeUpdateCustomer.mockResolvedValue({})
	mocks.inngestSend.mockResolvedValue({})
	mocks.sendServerEmail.mockResolvedValue(undefined)
	process.env.INNGEST_EVENT_KEY = 'test-key'
})

describe('getPurchaseTransferForPurchaseId', () => {
	it('returns nothing for anonymous callers and never queries', async () => {
		mocks.getServerAuthSession.mockResolvedValue(sessionFor(null))
		await expect(
			getPurchaseTransferForPurchaseId({ id: 'purchase_1' }),
		).resolves.toEqual([])
		expect(mocks.putFindMany).not.toHaveBeenCalled()
	})

	it('scopes the query to the session user only', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)
		mocks.putFindMany.mockResolvedValue([transferRow()])
		const result = await getPurchaseTransferForPurchaseId({ id: 'purchase_1' })
		expect(result).toHaveLength(1)
		expect(mocks.putFindMany).toHaveBeenCalledTimes(1)
	})
})

describe('initiatePurchaseTransfer', () => {
	const asOwner = () =>
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)

	it('initiates for the source owner via compare-and-swap and emails the target', async () => {
		asOwner()
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		mocks.findOrCreateUser.mockResolvedValue({
			user: { id: 'user_b', email: 'b@example.com' },
		})
		mocks.putFindFirst.mockResolvedValue(
			transferRow({ transferState: 'INITIATED', targetUserId: 'user_b' }),
		)

		await initiatePurchaseTransfer({
			purchaseUserTransferId: 'put_1',
			email: 'B@Example.com',
		})

		const putUpdates = updatesFor(purchaseUserTransferTable)
		expect(putUpdates).toHaveLength(1)
		expect(putUpdates[0]?.values).toMatchObject({
			transferState: 'INITIATED',
			targetUserId: 'user_b',
		})
		expect(mocks.findOrCreateUser).toHaveBeenCalledWith('b@example.com')
		expect(mocks.sendServerEmail).toHaveBeenCalledTimes(1)
	})

	it('denies anonymous callers with zero side effects', async () => {
		mocks.getServerAuthSession.mockResolvedValue(sessionFor(null))
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'b@example.com',
			}),
		).rejects.toThrow('You must be signed in')
		expect(mocks.findOrCreateUser).not.toHaveBeenCalled()
		expect(mocks.dbState.updates).toHaveLength(0)
		expect(mocks.sendServerEmail).not.toHaveBeenCalled()
	})

	it('denies a wrong user with zero side effects', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_c', email: 'c@example.com' }),
		)
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'b@example.com',
			}),
		).rejects.toThrow('Only the purchase owner')
		expect(mocks.findOrCreateUser).not.toHaveBeenCalled()
		expect(mocks.dbState.updates).toHaveLength(0)
	})

	it('marks an expired slot EXPIRED and refuses, before creating any user', async () => {
		asOwner()
		mocks.getPurchaseUserTransferById.mockResolvedValue(
			transferRow({ expiresAt: PAST }),
		)
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'b@example.com',
			}),
		).rejects.toThrow('expired')
		const putUpdates = updatesFor(purchaseUserTransferTable)
		expect(putUpdates).toHaveLength(1)
		expect(putUpdates[0]?.values).toMatchObject({ transferState: 'EXPIRED' })
		expect(mocks.findOrCreateUser).not.toHaveBeenCalled()
	})

	it('refuses a second transfer while one is in flight for the purchase', async () => {
		asOwner()
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		mocks.putFindMany.mockResolvedValue([
			transferRow({ id: 'put_other', transferState: 'INITIATED' }),
		])
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'b@example.com',
			}),
		).rejects.toThrow('already in progress')
		expect(mocks.findOrCreateUser).not.toHaveBeenCalled()
		expect(mocks.dbState.updates).toHaveLength(0)
	})

	it('refuses transferring to your own email before creating a user', async () => {
		asOwner()
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'A@example.com',
			}),
		).rejects.toThrow('yourself')
		expect(mocks.findOrCreateUser).not.toHaveBeenCalled()
	})

	it('rejects an invalid email with a curated message before creating a user', async () => {
		asOwner()
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'not-an-email',
			}),
		).rejects.toThrow('does not look valid')
		expect(mocks.findOrCreateUser).not.toHaveBeenCalled()
		expect(mocks.dbState.updates).toHaveLength(0)
	})

	it('loses a concurrent initiate race cleanly (no email, no second INITIATED)', async () => {
		asOwner()
		mocks.getPurchaseUserTransferById.mockResolvedValue(transferRow())
		mocks.findOrCreateUser.mockResolvedValue({
			user: { id: 'user_b', email: 'b@example.com' },
		})
		mocks.dbState.updateHandler = () => 0
		await expect(
			initiatePurchaseTransfer({
				purchaseUserTransferId: 'put_1',
				email: 'b@example.com',
			}),
		).rejects.toThrow('not available')
		expect(mocks.sendServerEmail).not.toHaveBeenCalled()
	})
})

describe('cancelPurchaseTransfer', () => {
	const initiated = () =>
		transferRow({ transferState: 'INITIATED', targetUserId: 'user_b' })

	it('cancels via compare-and-swap and recreates a single AVAILABLE slot', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.putFindMany.mockResolvedValue([])

		await cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' })

		const putUpdates = updatesFor(purchaseUserTransferTable)
		expect(putUpdates).toHaveLength(1)
		expect(putUpdates[0]?.values).toMatchObject({ transferState: 'CANCELED' })
		const putInserts = insertsFor(purchaseUserTransferTable)
		expect(putInserts).toHaveLength(1)
		expect(putInserts[0]?.values).toMatchObject({
			transferState: 'AVAILABLE',
			sourceUserId: 'user_a',
			purchaseId: 'purchase_1',
		})
	})

	it('denies anonymous and non-owner callers with zero writes', async () => {
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.getServerAuthSession.mockResolvedValue(sessionFor(null))
		await expect(
			cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('signed in')

		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_b', email: 'b@example.com' }),
		)
		await expect(
			cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('Only the purchase owner')
		expect(mocks.dbState.updates).toHaveLength(0)
		expect(mocks.dbState.inserts).toHaveLength(0)
	})

	it('denies a double cancel on an already-CANCELED transfer', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)
		mocks.getPurchaseUserTransferById.mockResolvedValue(
			transferRow({ transferState: 'CANCELED' }),
		)
		await expect(
			cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not available')
		expect(mocks.dbState.updates).toHaveLength(0)
		expect(mocks.dbState.inserts).toHaveLength(0)
	})

	it('loses a cancel/accept race without inserting a replacement slot', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.dbState.updateHandler = () => 0
		await expect(
			cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not available')
		expect(mocks.dbState.inserts).toHaveLength(0)
	})

	it('never creates a second open slot when one already exists', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.putFindMany.mockResolvedValue([
			transferRow({ id: 'put_other', transferState: 'AVAILABLE' }),
		])
		await cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' })
		expect(insertsFor(purchaseUserTransferTable)).toHaveLength(0)
	})
})

describe('acceptPurchaseTransfer', () => {
	const initiated = () =>
		transferRow({ transferState: 'INITIATED', targetUserId: 'user_b' })
	const verified = () =>
		transferRow({ transferState: 'VERIFIED', targetUserId: 'user_b' })
	const completed = () =>
		transferRow({ transferState: 'COMPLETED', targetUserId: 'user_b' })
	const asTarget = () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_b', email: 'b@example.com' }),
		)
		mocks.getUserById.mockResolvedValue({
			id: 'user_b',
			email: 'b@example.com',
			name: 'B',
		})
	}
	const claimUpdates = () =>
		updatesFor(purchaseUserTransferTable).filter(
			(u) => u.values.transferState === 'VERIFIED',
		)
	const expectConverged = () => {
		expect(updatesFor(purchaseTable)[0]?.values).toEqual({ userId: 'user_b' })
		expect(updatesFor(merchantCharge)[0]?.values).toEqual({ userId: 'user_b' })
		expect(updatesFor(merchantCustomer)[0]?.values).toEqual({
			userId: 'user_b',
		})
		const outboxInserts = insertsFor(purchaseTransferOutbox)
		expect(outboxInserts).toHaveLength(1)
		expect(outboxInserts[0]?.values).toMatchObject({
			status: 'PENDING',
			purchaseUserTransferId: 'put_1',
			targetUserId: 'user_b',
		})
		expect(outboxInserts[0]?.upsert).toBe(true)
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(updatesFor(purchaseTransferOutbox)[0]?.values).toMatchObject({
			status: 'PUBLISHED',
		})
		for (const update of updatesFor(purchaseUserTransferTable)) {
			expect(update.values.transferState).not.toBe('COMPLETED')
		}
	}

	it('claims INITIATED -> VERIFIED before touching Stripe, then converges', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		let claimsWhenStripeRan = -1
		mocks.stripeUpdateCustomer.mockImplementation(async () => {
			claimsWhenStripeRan = claimUpdates().length
			return {}
		})

		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' })

		expect(claimUpdates()).toHaveLength(1)
		expect(claimsWhenStripeRan).toBe(1)
		expect(mocks.stripeUpdateCustomer).toHaveBeenCalledTimes(1)
		expectConverged()
	})

	it('denies a wrong user (leaked link holder) with zero writes and no Stripe call', async () => {
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_c', email: 'c@example.com' }),
		)
		mocks.getUserById.mockResolvedValue({
			id: 'user_c',
			email: 'c@example.com',
		})
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not the target user')
		expect(mocks.dbState.updates).toHaveLength(0)
		expect(mocks.dbState.inserts).toHaveLength(0)
		expect(mocks.stripeUpdateCustomer).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('marks an expired transfer EXPIRED and refuses', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(
			transferRow({
				transferState: 'INITIATED',
				targetUserId: 'user_b',
				expiresAt: PAST,
			}),
		)
		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('expired')
		const putUpdates = updatesFor(purchaseUserTransferTable)
		expect(putUpdates).toHaveLength(1)
		expect(putUpdates[0]?.values).toMatchObject({ transferState: 'EXPIRED' })
		expect(mocks.stripeUpdateCustomer).not.toHaveBeenCalled()
	})

	it('denies accepting a canceled transfer', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(
			transferRow({ transferState: 'CANCELED', targetUserId: 'user_b' }),
		)
		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not available')
		expect(mocks.dbState.updates).toHaveLength(0)
	})

	it('cancel race: a cancel that wins first denies the accept before any Stripe write', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById
			.mockResolvedValueOnce(initiated())
			// The concurrent cancel committed between our read and our CAS.
			.mockResolvedValueOnce(
				transferRow({ transferState: 'CANCELED', targetUserId: 'user_b' }),
			)
		mocks.dbState.updateHandler = () => 0

		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not available')

		expect(mocks.stripeGetCustomer).not.toHaveBeenCalled()
		expect(mocks.stripeUpdateCustomer).not.toHaveBeenCalled()
		expect(updatesFor(purchaseTable)).toHaveLength(0)
		expect(insertsFor(purchaseTransferOutbox)).toHaveLength(0)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
		// Only the failed CAS attempt was issued.
		expect(mocks.dbState.updates).toHaveLength(1)
	})

	it('cancel cannot win after the claim: once VERIFIED the cancel CAS from INITIATED finds nothing', async () => {
		// Owner reads INITIATED, target claims in between, owner CAS loses.
		mocks.getServerAuthSession.mockResolvedValue(
			sessionFor({ id: 'user_a', email: 'a@example.com' }),
		)
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.dbState.updateHandler = () => 0
		await expect(
			cancelPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not available')
		expect(insertsFor(purchaseUserTransferTable)).toHaveLength(0)
	})

	it('Stripe failure: claim stays VERIFIED with no local ownership writes, and re-accept resumes cleanly', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.stripeUpdateCustomer.mockRejectedValueOnce(new Error('stripe down'))

		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('stripe down')

		expect(claimUpdates()).toHaveLength(1)
		expect(updatesFor(purchaseTable)).toHaveLength(0)
		expect(updatesFor(merchantCharge)).toHaveLength(0)
		expect(insertsFor(purchaseTransferOutbox)).toHaveLength(0)
		expect(mocks.inngestSend).not.toHaveBeenCalled()

		// Target retries; the row is now VERIFIED for them.
		mocks.getPurchaseUserTransferById.mockResolvedValue(verified())
		mocks.stripeUpdateCustomer.mockResolvedValue({})
		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' })

		// No second claim, one converged completion.
		expect(claimUpdates()).toHaveLength(1)
		expectConverged()
	})

	it('transaction failure after Stripe: re-accept resumes and converges without a second claim', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.dbState.updateHandler = (call) => {
			if (call.table === purchaseTable) throw new Error('db blip')
			return 1
		}

		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('db blip')
		expect(mocks.stripeUpdateCustomer).toHaveBeenCalledTimes(1)
		expect(claimUpdates()).toHaveLength(1)
		expect(mocks.inngestSend).not.toHaveBeenCalled()

		// Retry: VERIFIED row, database healthy again. Discard the failed
		// attempt's partial log so convergence is asserted on the retry alone.
		mocks.dbState.updates = []
		mocks.dbState.inserts = []
		mocks.dbState.updateHandler = () => 1
		mocks.getPurchaseUserTransferById.mockResolvedValue(verified())
		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' })

		expect(claimUpdates()).toHaveLength(0)
		expect(mocks.stripeUpdateCustomer).toHaveBeenCalledTimes(2)
		expectConverged()
	})

	it('heals a legacy pre-outbox VERIFIED transfer: re-accept creates the synthetic outbox row and publishes', async () => {
		asTarget()
		// Ownership already moved by the old accept; no outbox row exists.
		mocks.getPurchaseUserTransferById.mockResolvedValue(verified())
		mocks.purchasesFindFirst.mockResolvedValue(
			purchaseRow({ userId: 'user_b' }),
		)

		const result = await acceptPurchaseTransfer({
			purchaseUserTransferId: 'put_1',
		})

		expect(result).toHaveProperty('completedTransfer')
		expect(claimUpdates()).toHaveLength(0)
		expectConverged()
	})

	it('a resumed accept cannot duplicate the outbox row: the insert is an upsert on the transfer/event key', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(verified())
		// A row already exists from an earlier attempt and was never published.
		mocks.outboxFindMany.mockResolvedValue([
			{ id: 'pto_existing', status: 'PENDING' },
		])

		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' })

		const outboxInserts = insertsFor(purchaseTransferOutbox)
		expect(outboxInserts).toHaveLength(1)
		expect(outboxInserts[0]?.upsert).toBe(true)
		// The existing row, not a new id, is what gets published.
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(updatesFor(purchaseTransferOutbox)[0]?.values).toMatchObject({
			status: 'PUBLISHED',
		})
	})

	it('competing accept: the loser of the claim race resumes the same target claim and converges', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById
			.mockResolvedValueOnce(initiated())
			.mockResolvedValueOnce(verified())
		// Claim CAS loses; everything else succeeds.
		mocks.dbState.updateHandler = (call) =>
			call.values.transferState === 'VERIFIED' ? 0 : 1

		const result = await acceptPurchaseTransfer({
			purchaseUserTransferId: 'put_1',
		})
		expect(result).toHaveProperty('completedTransfer')
		expectConverged()
	})

	it('rejects a double-accept race that resolved to a different outcome', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById
			.mockResolvedValueOnce(initiated())
			.mockResolvedValueOnce(
				transferRow({ transferState: 'CANCELED', targetUserId: 'user_b' }),
			)
		mocks.dbState.updateHandler = () => 0
		await expect(
			acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' }),
		).rejects.toThrow('not available')
		expect(mocks.stripeUpdateCustomer).not.toHaveBeenCalled()
	})

	it('treats accept on a COMPLETED transfer as a replay: no writes, no Stripe', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(completed())
		const result = await acceptPurchaseTransfer({
			purchaseUserTransferId: 'put_1',
		})
		expect(result).toHaveProperty('newPurchase')
		expect(mocks.dbState.updates).toHaveLength(0)
		expect(mocks.dbState.inserts).toHaveLength(0)
		expect(mocks.stripeUpdateCustomer).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('a COMPLETED replay still republishes a previously failed outbox event', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(completed())
		mocks.outboxFindMany.mockResolvedValue([
			{ id: 'pto_stalled', status: 'FAILED' },
		])
		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' })
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(updatesFor(purchaseTransferOutbox)[0]?.values).toMatchObject({
			status: 'PUBLISHED',
		})
		expect(mocks.stripeUpdateCustomer).not.toHaveBeenCalled()
	})

	it('keeps the committed transfer visible when the Inngest publish fails', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.inngestSend.mockRejectedValue(new Error('inngest down'))

		const result = await acceptPurchaseTransfer({
			purchaseUserTransferId: 'put_1',
		})

		expect(result).toHaveProperty('newPurchase')
		expect(updatesFor(purchaseTable)[0]?.values).toEqual({ userId: 'user_b' })
		const outboxUpdates = updatesFor(purchaseTransferOutbox)
		expect(outboxUpdates[0]?.values).toMatchObject({ status: 'FAILED' })
		expect(outboxUpdates[0]?.values.lastError).toContain('inngest down')
		expect(mocks.log.error).toHaveBeenCalledWith(
			'purchase_transfer.accept_event_publish_failed',
			expect.objectContaining({ purchaseUserTransferId: 'put_1' }),
		)
		for (const update of updatesFor(purchaseUserTransferTable)) {
			expect(update.values.transferState).not.toBe('COMPLETED')
		}
	})

	it('a failed FAILED-status write after a failed publish is logged, not thrown, and leaves the row recoverable', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		mocks.inngestSend.mockRejectedValue(new Error('inngest down'))
		mocks.dbState.updateHandler = (call) => {
			if (
				call.table === purchaseTransferOutbox &&
				call.values.status === 'FAILED'
			) {
				throw new Error('db blip')
			}
			return 1
		}

		const result = await acceptPurchaseTransfer({
			purchaseUserTransferId: 'put_1',
		})

		expect(result).toHaveProperty('newPurchase')
		expect(mocks.log.error).toHaveBeenCalledWith(
			'purchase_transfer.outbox_failure_record_failed',
			expect.objectContaining({
				publishError: 'inngest down',
				recordError: 'db blip',
			}),
		)
		// No PUBLISHED or FAILED status landed: the row is still PENDING,
		// which the recovery query treats as unpublished.
		const statuses = updatesFor(purchaseTransferOutbox).map(
			(u) => u.values.status,
		)
		expect(statuses).not.toContain('PUBLISHED')
	})

	it('a missing INNGEST_EVENT_KEY is a visible outbox failure, not a lost transfer', async () => {
		asTarget()
		mocks.getPurchaseUserTransferById.mockResolvedValue(initiated())
		delete process.env.INNGEST_EVENT_KEY

		await acceptPurchaseTransfer({ purchaseUserTransferId: 'put_1' })

		const outboxUpdates = updatesFor(purchaseTransferOutbox)
		expect(outboxUpdates[0]?.values).toMatchObject({ status: 'FAILED' })
	})
})
