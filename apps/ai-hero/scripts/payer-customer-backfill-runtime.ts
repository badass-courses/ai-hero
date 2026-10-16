import {
	and,
	eq,
	gt,
	inArray,
	isNull,
	ne,
	notExists,
	or,
	sql,
} from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { access } from 'node:fs/promises'

import * as schema from '../src/db/schema'
import { resolveInvoicePayer } from '../src/lib/invoice-access-rules'
import { readDisputeRecord } from '../src/lib/purchase-dispute-machine'
import {
	fileJournal,
	type Args,
	type BackfillPorts,
	type CustomerFacts,
	type PurchaseFacts,
	type StripeCustomerFacts,
} from './payer-customer-backfill'

type Db = MySql2Database<typeof schema>

/** Transfer states that mean a holder could still change under the run. */
export const IN_FLIGHT_TRANSFER_STATES = [
	'INITIATED',
	'VERIFIED',
	'CONFIRMED',
] as const

/** Unexpired transfers in an open state. An expired one can no longer complete; no expiry counts. */
const openTransferWhere = (now: Date) =>
	and(
		inArray(schema.purchaseUserTransfer.transferState, [
			...IN_FLIGHT_TRANSFER_STATES,
		]),
		or(
			isNull(schema.purchaseUserTransfer.expiresAt),
			gt(schema.purchaseUserTransfer.expiresAt, now),
		),
	)

export function getRowsAffected(result: unknown): number {
	if (
		result &&
		typeof result === 'object' &&
		'rowsAffected' in result &&
		typeof (result as { rowsAffected: unknown }).rowsAffected === 'number'
	)
		return (result as { rowsAffected: number }).rowsAffected
	if (Array.isArray(result)) {
		const header = result[0]
		if (
			header &&
			typeof header === 'object' &&
			'affectedRows' in header &&
			typeof (header as { affectedRows: unknown }).affectedRows === 'number'
		)
			return (header as { affectedRows: number }).affectedRows
	}
	return 0
}

/** Database half of the ports. The rig test runs this against a real MySQL. */
export function createDrizzleDbPorts(db: Db) {
	return {
		async loadCustomerRows() {
			// Customers with at least one purchase that has a COMPLETED transfer.
			const rows = await db
				.selectDistinct({
					customerId: schema.merchantCustomer.id,
					stripeCustomerId: schema.merchantCustomer.identifier,
					holderUserId: schema.merchantCustomer.userId,
				})
				.from(schema.merchantCustomer)
				.innerJoin(
					schema.merchantCharge,
					eq(
						schema.merchantCharge.merchantCustomerId,
						schema.merchantCustomer.id,
					),
				)
				.innerJoin(
					schema.purchases,
					eq(schema.purchases.merchantChargeId, schema.merchantCharge.id),
				)
				.innerJoin(
					schema.purchaseUserTransfer,
					eq(schema.purchaseUserTransfer.purchaseId, schema.purchases.id),
				)
				.where(eq(schema.purchaseUserTransfer.transferState, 'COMPLETED'))
			return rows
		},
		async loadCustomerRow(customerId: string) {
			const [row] = await db
				.select({
					customerId: schema.merchantCustomer.id,
					stripeCustomerId: schema.merchantCustomer.identifier,
					holderUserId: schema.merchantCustomer.userId,
				})
				.from(schema.merchantCustomer)
				.where(eq(schema.merchantCustomer.id, customerId))
			return row ?? null
		},
		async loadDbFacts(customer: {
			customerId: string
			holderUserId: string
		}): Promise<
			Pick<
				CustomerFacts,
				'purchases' | 'users' | 'activeSubscriptionRows' | 'payerOtherCustomers'
			>
		> {
			const purchaseRows = await db
				.select({
					purchaseId: schema.purchases.id,
					status: schema.purchases.status,
					fields: schema.purchases.fields,
					chargeUserId: schema.merchantCharge.userId,
				})
				.from(schema.merchantCharge)
				.innerJoin(
					schema.purchases,
					eq(schema.purchases.merchantChargeId, schema.merchantCharge.id),
				)
				.where(
					eq(schema.merchantCharge.merchantCustomerId, customer.customerId),
				)
			const ids = purchaseRows.map((p) => p.purchaseId)
			const transfers = ids.length
				? await db
						.select()
						.from(schema.purchaseUserTransfer)
						.where(inArray(schema.purchaseUserTransfer.purchaseId, ids))
				: []
			const purchases: PurchaseFacts[] = purchaseRows.map((p) => ({
				purchaseId: p.purchaseId,
				chargeUserId: p.chargeUserId,
				openDispute:
					p.status === 'Disputed' ||
					readDisputeRecord(p.fields)?.state === 'open',
				transfers: transfers
					.filter((t) => t.purchaseId === p.purchaseId)
					.map((t) => ({
						id: t.id,
						state: t.transferState,
						sourceUserId: t.sourceUserId,
						completedAt: t.completedAt,
						createdAt: t.createdAt,
					})),
			}))
			const userIds = [
				...new Set([
					customer.holderUserId,
					...purchases.flatMap((p) => [
						...(p.chargeUserId ? [p.chargeUserId] : []),
						...p.transfers.map((t) => t.sourceUserId),
					]),
				]),
			]
			const userRows = await db
				.select({
					id: schema.users.id,
					email: schema.users.email,
					name: schema.users.name,
				})
				.from(schema.users)
				.where(inArray(schema.users.id, userIds))
			const [active] = await db
				.select({ n: sql<number>`count(*)` })
				.from(schema.merchantSubscription)
				.innerJoin(
					schema.subscription,
					eq(
						schema.subscription.merchantSubscriptionId,
						schema.merchantSubscription.id,
					),
				)
				.where(
					and(
						eq(
							schema.merchantSubscription.merchantCustomerId,
							customer.customerId,
						),
						eq(schema.subscription.status, 'active'),
					),
				)
			// How many other customers the payer already owns (informational).
			const payers = new Set(
				purchases.map((p) =>
					resolveInvoicePayer({
						chargeUserId: p.chargeUserId,
						transfers: p.transfers,
					}),
				),
			)
			const payer = payers.size === 1 ? [...payers][0] : null
			const [others] = payer
				? await db
						.select({ n: sql<number>`count(*)` })
						.from(schema.merchantCustomer)
						.where(
							and(
								eq(schema.merchantCustomer.userId, payer),
								ne(schema.merchantCustomer.id, customer.customerId),
							),
						)
				: [{ n: 0 }]
			return {
				payerOtherCustomers: Number(others?.n ?? 0),
				purchases,
				users: Object.fromEntries(userRows.map((u) => [u.id, u])),
				activeSubscriptionRows: Number(active?.n ?? 0),
			}
		},
		async inFlightTransferUserIds() {
			const rows = await db
				.select({
					source: schema.purchaseUserTransfer.sourceUserId,
					target: schema.purchaseUserTransfer.targetUserId,
				})
				.from(schema.purchaseUserTransfer)
				.where(openTransferWhere(new Date()))
			return new Set(
				rows
					.flatMap((r) => [r.source, r.target])
					.filter((id): id is string => !!id),
			)
		},
		/** One transaction, one guarded update; zero rows affected is a conflict. */
		async compareAndSet(input: {
			customerId: string
			holderUserId: string
			payerUserId: string
		}) {
			return db.transaction(async (tx) => {
				// One clock for the NOT EXISTS clause and the lookup after it, so a
				// transfer expiring in between cannot turn a deferral into a conflict.
				const now = new Date()
				// The open-transfer check lives in the same statement as the update,
				// so no transfer can open between the check and the write.
				const touchesRow = or(
					inArray(schema.purchaseUserTransfer.sourceUserId, [
						input.holderUserId,
						input.payerUserId,
					]),
					inArray(schema.purchaseUserTransfer.targetUserId, [
						input.holderUserId,
						input.payerUserId,
					]),
				)
				const result = await tx
					.update(schema.merchantCustomer)
					.set({ userId: input.payerUserId })
					.where(
						and(
							eq(schema.merchantCustomer.id, input.customerId),
							eq(schema.merchantCustomer.userId, input.holderUserId),
							notExists(
								tx
									.select({ one: sql`1` })
									.from(schema.purchaseUserTransfer)
									.where(and(openTransferWhere(now), touchesRow)),
							),
						),
					)
				const affected = getRowsAffected(result)
				if (affected > 0) return affected
				// Zero rows: a deferral only if the row is still on the holder and an
				// open transfer names the holder or payer; otherwise a plain conflict.
				const [row] = await tx
					.select({ userId: schema.merchantCustomer.userId })
					.from(schema.merchantCustomer)
					.where(eq(schema.merchantCustomer.id, input.customerId))
				if (row?.userId !== input.holderUserId) return 0
				const [open] = await tx
					.select({ one: sql`1` })
					.from(schema.purchaseUserTransfer)
					.where(and(openTransferWhere(now), touchesRow))
					.limit(1)
				return open ? ('deferred' as const) : 0
			})
		},
		async readCustomerUserId(customerId: string) {
			const [row] = await db
				.select({ userId: schema.merchantCustomer.userId })
				.from(schema.merchantCustomer)
				.where(eq(schema.merchantCustomer.id, customerId))
			return row?.userId ?? null
		},
	}
}

/** The slice of the Stripe client this script uses. Reads and one update. */
export type StripeLike = {
	customers: {
		retrieve(id: string): Promise<{
			deleted?: boolean
			email?: string | null
			name?: string | null
		}>
		update(
			id: string,
			params: { email: string; name: string },
			options: { idempotencyKey: string },
		): Promise<unknown>
		/** `GET /v1/customers/:id/payment_methods`: `type` is optional there. */
		listPaymentMethods(
			id: string,
			params: { limit: number },
		): List<{ created: number }>
		/** Legacy sources and cards; cards carry no `created`. */
		listSources(
			id: string,
			params: { limit: number },
		): List<{ created?: number }>
	}
	charges: {
		list(p: {
			customer: string
			limit: number
		}): List<{ created: number; disputed?: boolean }>
	}
	paymentIntents: {
		list(p: { customer: string; limit: number }): List<{ created: number }>
	}
	invoices: {
		list(p: { customer: string; limit: number }): List<{ created: number }>
	}
	subscriptions: {
		list(p: { customer: string; status: 'all'; limit: number }): List<{
			created: number
			status: string
		}>
	}
}
type List<T> = { autoPagingToArray(o: { limit: number }): Promise<T[]> }

const PAGE_CAP = 5000

export async function readStripeFacts(
	stripe: StripeLike,
	stripeCustomerId: string,
	throttle: () => Promise<void>,
): Promise<StripeCustomerFacts> {
	await throttle()
	const customer = await stripe.customers.retrieve(stripeCustomerId)
	if (customer.deleted)
		return {
			deleted: true,
			email: null,
			name: null,
			chargeCreated: [],
			paymentIntentCreated: [],
			paymentMethodCreated: [],
			invoiceCreated: [],
			chargeDisputed: false,
			subscriptions: [],
		}
	const base = { customer: stripeCustomerId, limit: 100 }
	const page = { limit: 100 }
	const all = { limit: PAGE_CAP }
	await throttle()
	const charges = await stripe.charges.list(base).autoPagingToArray(all)
	await throttle()
	const intents = await stripe.paymentIntents.list(base).autoPagingToArray(all)
	await throttle()
	const invoices = await stripe.invoices.list(base).autoPagingToArray(all)
	await throttle()
	const methods = await stripe.customers
		.listPaymentMethods(stripeCustomerId, page)
		.autoPagingToArray(all)
	await throttle()
	const sources = await stripe.customers
		.listSources(stripeCustomerId, page)
		.autoPagingToArray(all)
	await throttle()
	const subs = await stripe.subscriptions
		.list({ ...base, status: 'all' })
		.autoPagingToArray(all)
	return {
		deleted: false,
		email: customer.email ?? null,
		name: customer.name ?? null,
		chargeCreated: charges.map((c) => c.created),
		paymentIntentCreated: intents.map((c) => c.created),
		// A legacy source with no creation time cannot be proven old: it counts.
		paymentMethodCreated: [
			...methods.map((m) => m.created),
			...sources.map((x) => x.created ?? Number.POSITIVE_INFINITY),
		],
		invoiceCreated: invoices.map((c) => c.created),
		chargeDisputed: charges.some((c) => c.disputed === true),
		subscriptions: subs.map((s) => ({ created: s.created, status: s.status })),
	}
}

export function createRateLimiter(
	perSecond: number,
	now: () => number = Date.now,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
) {
	const gap = 1000 / perSecond
	let next = 0
	return async () => {
		const wait = next - now()
		if (wait > 0) await sleep(wait)
		next = Math.max(now(), next) + gap
	}
}

export function assembleCustomerFacts(
	db: ReturnType<typeof createDrizzleDbPorts>,
	stripe: StripeLike,
	throttle: () => Promise<void>,
) {
	return async (): Promise<CustomerFacts[]> => {
		const customers = await db.loadCustomerRows()
		const facts: CustomerFacts[] = []
		for (const customer of customers)
			facts.push({
				...customer,
				...(await db.loadDbFacts(customer)),
				stripe: await readStripeFacts(
					stripe,
					customer.stripeCustomerId,
					throttle,
				),
			})
		return facts
	}
}

export function createPorts(options: {
	db: Db
	stripe: StripeLike
	journalPath?: string
	stopFile?: string
	rate: number
}): BackfillPorts {
	const dbPorts = createDrizzleDbPorts(options.db)
	const throttle = createRateLimiter(options.rate)
	const journal = options.journalPath ? fileJournal(options.journalPath) : null
	const needJournal = () => {
		if (!journal) throw new Error('journal path missing')
		return journal
	}
	return {
		loadFacts: assembleCustomerFacts(dbPorts, options.stripe, throttle),
		loadCustomerFacts: async (customerId) => {
			const row = await dbPorts.loadCustomerRow(customerId)
			if (!row) return null
			return {
				...row,
				...(await dbPorts.loadDbFacts(row)),
				stripe: await readStripeFacts(
					options.stripe,
					row.stripeCustomerId,
					throttle,
				),
			}
		},
		inFlightTransferUserIds: dbPorts.inFlightTransferUserIds,
		compareAndSet: dbPorts.compareAndSet,
		readCustomerUserId: dbPorts.readCustomerUserId,
		updateStripeCustomer: async ({
			stripeCustomerId,
			email,
			name,
			idempotencyKey,
		}) => {
			// Email and name only. Nothing else on the customer is touched.
			await options.stripe.customers.update(
				stripeCustomerId,
				{ email, name },
				{ idempotencyKey },
			)
		},
		readStripeCustomer: async (id) => {
			const customer = await options.stripe.customers.retrieve(id)
			return customer.deleted
				? null
				: { email: customer.email ?? null, name: customer.name ?? null }
		},
		readJournal: () => needJournal().read(),
		appendJournal: (entry) => needJournal().append(entry),
		stopRequested: async () => {
			if (!options.stopFile) return false
			try {
				await access(options.stopFile)
				return true
			} catch {
				return false
			}
		},
		throttle,
	}
}

/** Lazy operator loader: the only place that opens the database and Stripe. */
export async function createProductionPorts(args: Args) {
	const [{ db, closeDatabasePool }, { env }, { default: StripeClient }] =
		await Promise.all([
			import('../src/db'),
			import('../src/env.mjs'),
			import('stripe'),
		])
	const stripe = new StripeClient(
		env.STRIPE_SECRET_TOKEN,
	) as unknown as StripeLike
	return {
		ports: createPorts({
			db: db as unknown as Db,
			stripe,
			journalPath: args.mode === 'dry-run' ? undefined : args.journal,
			stopFile: args.mode === 'write' ? args.stopFile : undefined,
			rate: args.rate,
		}),
		close: closeDatabasePool,
	}
}
