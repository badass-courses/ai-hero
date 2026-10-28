import { mysqlTable } from '@/db/mysql-table'
import {
	bigint,
	index,
	int,
	json,
	mysqlEnum,
	primaryKey,
	timestamp,
	varchar,
} from 'drizzle-orm/mysql-core'

/**
 * One durable receipt per Stripe invoice. Both reserved and paid consume seats.
 * reserved -> paid | released; terminal receipts must never be deleted/reused.
 *
 * Schema only: this does not enforce the spending invariant. The reserve path
 * must lock every eligible source Purchase row in id order, read consumption
 * with current locking reads, and insert the receipt + allocations in ONE
 * transaction. Purchase ids, not org/customer aliases, own consumption.
 */
export const ccCreditReservation = mysqlTable(
	'CcCreditReservation',
	{
		invoiceId: varchar('invoiceId', { length: 191 }).notNull().primaryKey(),
		stripeCustomerId: varchar('stripeCustomerId', { length: 191 }).notNull(),
		// Legacy bulk purchases may not belong to an organization yet.
		organizationId: varchar('organizationId', { length: 191 }),
		// SHA-256 of the canonical request. Replays with changed inputs refuse.
		requestHash: varchar('requestHash', { length: 64 }).notNull(),
		seats: int('seats', { unsigned: true }).notNull(),
		amountCents: bigint('amountCents', {
			mode: 'number',
			unsigned: true,
		}).notNull(),
		currency: varchar('currency', { length: 3 }).notNull(),
		status: mysqlEnum('status', ['reserved', 'paid', 'released']).notNull(),
		// Operator/run/approval references, never secrets or message bodies.
		audit: json('audit').$type<Record<string, string>>().notNull(),
		createdAt: timestamp('createdAt', { mode: 'date', fsp: 3 }).notNull(),
		updatedAt: timestamp('updatedAt', { mode: 'date', fsp: 3 }).notNull(),
		paidAt: timestamp('paidAt', { mode: 'date', fsp: 3 }),
		releasedAt: timestamp('releasedAt', { mode: 'date', fsp: 3 }),
	},
	(table) => ({
		organizationStatusIdx: index('CcCreditReservation_org_status_idx').on(
			table.organizationId,
			table.status,
		),
		customerStatusIdx: index('CcCreditReservation_customer_status_idx').on(
			table.stripeCustomerId,
			table.status,
		),
		// Bounded desk reconciliation of outstanding Stripe invoices.
		statusUpdatedIdx: index('CcCreditReservation_status_updated_idx').on(
			table.status,
			table.updatedAt,
		),
	}),
)

/**
 * Immutable allocation snapshots, one per source purchase per invoice.
 * Join to the receipt for status; released allocations remain as audit evidence.
 * No foreign keys: PlanetScale deployment and app transactions own integrity.
 */
export const ccCreditAllocation = mysqlTable(
	'CcCreditAllocation',
	{
		invoiceId: varchar('invoiceId', { length: 191 }).notNull(),
		purchaseId: varchar('purchaseId', { length: 191 }).notNull(),
		seats: int('seats', { unsigned: true }).notNull(),
		perSeatCents: bigint('perSeatCents', {
			mode: 'number',
			unsigned: true,
		}).notNull(),
		// Source evidence at reservation time, not mutable purchase fields.
		purchaseSeats: int('purchaseSeats', { unsigned: true }).notNull(),
		purchaseTotalCents: bigint('purchaseTotalCents', {
			mode: 'number',
			unsigned: true,
		}).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.invoiceId, table.purchaseId] }),
		// Consumption follows a purchase even if its owner/org later changes.
		purchaseInvoiceIdx: index('CcCreditAllocation_purchase_invoice_idx').on(
			table.purchaseId,
			table.invoiceId,
		),
	}),
)
