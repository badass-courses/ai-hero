import {
	index,
	int,
	primaryKey,
	timestamp,
	varchar,
} from 'drizzle-orm/mysql-core'

import { mysqlTable } from './mysql-table'

const id = (name: string) => varchar(name, { length: 191 })
const hash = (name: string) => varchar(name, { length: 64 })
const time = (name: string) => timestamp(name, { mode: 'date', fsp: 3 })

// One seeded row for AI Hero's single desk issuer. The row lock serializes
// admission/mint chunks with switch changes; it is not held across network IO.
export const couponBatchControl = mysqlTable('CouponBatchControl', {
	id: id('id').primaryKey(),
	enabled: int('enabled').notNull().default(0),
	chunkSize: int('chunkSize').notNull().default(100),
	paceMs: int('paceMs').notNull().default(250),
	nextChunkAt: time('nextChunkAt'),
})

export const couponBatchGrant = mysqlTable('CouponBatchGrant', {
	principalId: id('principalId').primaryKey(),
	canMint: int('canMint').notNull().default(0),
	canRead: int('canRead').notNull().default(0),
})

// Also the one redacted audit record per accepted batch. No raw campaign,
// intent, token secret or selector belongs here.
export const couponBatch = mysqlTable(
	'CouponBatch',
	{
		id: id('id').primaryKey(),
		principalId: id('principalId').notNull(),
		credentialId: id('credentialId').notNull(),
		requestKey: hash('requestKey').notNull(),
		fingerprint: hash('fingerprint').notNull(),
		itemFingerprint: hash('itemFingerprint').notNull(),
		campaignHash: hash('campaignHash').notNull(),
		templateId: varchar('templateId', { length: 32 }).notNull(),
		policyRevision: varchar('policyRevision', { length: 16 }).notNull(),
		deadlineAt: time('deadlineAt').notNull(),
		acceptedAt: time('acceptedAt').notNull(),
		acceptedDay: varchar('acceptedDay', { length: 10 }).notNull(),
		finishedAt: time('finishedAt'),
		exportUntil: time('exportUntil').notNull(),
		total: int('total').notNull(),
		processed: int('processed').notNull().default(0),
		minted: int('minted').notNull().default(0),
		refused: int('refused').notNull().default(0),
		newIntents: int('newIntents').notNull().default(0),
		newMints: int('newMints').notNull().default(0),
		requestAlarm: int('requestAlarm').notNull().default(0),
		dailyAlarm: int('dailyAlarm').notNull().default(0),
		attempts: int('attempts').notNull().default(0),
		nextAttemptAt: time('nextAttemptAt').notNull(),
	},
	(t) => ({
		queue: index('CouponBatch_queue').on(
			t.finishedAt,
			t.nextAttemptAt,
			t.acceptedAt,
		),
	}),
)

// Complete manifest in ordinal order. Rows only become runnable in paced
// slices. Scope all reads through the owning batch before exposing intent keys.
export const couponBatchItem = mysqlTable(
	'CouponBatchItem',
	{
		batchId: id('batchId').notNull(),
		ordinal: int('ordinal').notNull(),
		intentKey: varchar('intentKey', { length: 128 }).notNull(),
		intentId: hash('intentId').notNull(),
		result: varchar('result', { length: 48 }),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.batchId, t.ordinal] }),
		lookup: index('CouponBatchItem_lookup').on(t.intentId, t.batchId),
	}),
)

// Terminal dedupe ledger. Don't delete these rows on export expiry.
export const couponBatchIntent = mysqlTable('CouponBatchIntent', {
	id: hash('id').primaryKey(),
	principalId: id('principalId').notNull(),
	fingerprint: hash('fingerprint').notNull(),
	couponRef: id('couponRef'),
	sealedCode: varchar('sealedCode', { length: 191 }),
	expiresAt: time('expiresAt').notNull(),
	exportUntil: time('exportUntil').notNull(),
	refused: varchar('refused', { length: 48 }),
})

export const couponBatchDay = mysqlTable('CouponBatchDay', {
	day: varchar('day', { length: 10 }).primaryKey(),
	intents: int('intents').notNull(),
	mints: int('mints').notNull(),
})

export const couponBatchAlert = mysqlTable(
	'CouponBatchAlert',
	{
		id: id('id').primaryKey(),
		batchId: id('batchId').notNull(),
		kind: varchar('kind', { length: 16 }).notNull(),
		count: int('count').notNull(),
		threshold: int('threshold').notNull(),
		loggedAt: time('loggedAt'),
		deliveredAt: time('deliveredAt'),
		attempts: int('attempts').notNull().default(0),
		nextAttemptAt: time('nextAttemptAt').notNull(),
	},
	(t) => ({
		due: index('CouponBatchAlert_due').on(t.deliveredAt, t.nextAttemptAt),
	}),
)
