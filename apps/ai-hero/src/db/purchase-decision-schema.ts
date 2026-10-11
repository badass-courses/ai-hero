import { mysqlTable } from '@/db/mysql-table'
import { index, int, timestamp, varchar } from 'drizzle-orm/mysql-core'

/** Insert-only pricing ledger, independent of mutable Purchase.fields. */
export const purchaseDecision = mysqlTable(
	'PurchaseDecision',
	{
		purchaseId: varchar('purchaseId', { length: 191 }).primaryKey(),
		productId: varchar('productId', { length: 191 }).notNull(),
		decisionRef: varchar('decisionRef', { length: 500 }).notNull(),
		creditSource: varchar('creditSource', { length: 191 }),
		codeRef: varchar('codeRef', { length: 500 }),
		giftClaimId: varchar('giftClaimId', { length: 191 }),
		giftSlot: int('giftSlot'),
		// The current checkout contract does not carry basis; never invent it.
		basis: varchar('basis', { length: 191 }),
		restriction: varchar('restriction', { length: 16 }).notNull(),
		amountCents: int('amountCents'),
		contract: varchar('contract', { length: 191 }).notNull(),
		engineVersion: varchar('engineVersion', { length: 191 }).notNull(),
		policyVersion: varchar('policyVersion', { length: 191 }).notNull(),
		checkoutSessionId: varchar('checkoutSessionId', { length: 191 }).notNull(),
		createdAt: timestamp('createdAt', { mode: 'date', fsp: 3 }).notNull(),
	},
	(table) => ({
		creditSourceIdx: index('PurchaseDecision_creditSource_idx').on(
			table.creditSource,
			table.productId,
		),
		codeRefIdx: index('PurchaseDecision_codeRef_idx').on(table.codeRef),
	}),
)
