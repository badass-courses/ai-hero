import { mysqlTable } from '@/db/mysql-table'
import {
	index,
	int,
	json,
	primaryKey,
	timestamp,
	uniqueIndex,
	varchar,
} from 'drizzle-orm/mysql-core'

export const evergreenOfferJourneyCommit = mysqlTable(
	'EvergreenOfferJourneyCommit',
	{
		format: varchar('format', { length: 64 }).notNull(),
		stimulusId: varchar('stimulusId', { length: 500 }).notNull(),
		journeyId: varchar('journeyId', { length: 500 }).notNull(),
		actorVersion: int('actorVersion', { unsigned: true }).notNull(),
		stimulusType: varchar('stimulusType', { length: 64 }).notNull(),
		commitEvidence: json('commitEvidence').$type<unknown>().notNull(),
		decision: json('decision').$type<unknown>().notNull(),
		snapshot: json('snapshot').$type<unknown>().notNull(),
		events: json('events').$type<unknown>().notNull(),
		receipt: json('receipt').$type<unknown>().notNull(),
		decidedAt: timestamp('decidedAt', { mode: 'date', fsp: 3 }).notNull(),
		committedAt: timestamp('committedAt', { mode: 'date', fsp: 3 })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		journeyVersionPk: primaryKey({
			columns: [table.journeyId, table.actorVersion],
		}),
		stimulusIdUq: uniqueIndex('EvergreenOfferJourneyCommit_stimulusId_uq').on(
			table.stimulusId,
		),
	}),
)

export const evergreenOfferJourneyIntent = mysqlTable(
	'EvergreenOfferJourneyIntent',
	{
		format: varchar('format', { length: 64 }).notNull(),
		idempotencyKey: varchar('idempotencyKey', { length: 500 })
			.notNull()
			.primaryKey(),
		journeyId: varchar('journeyId', { length: 500 }).notNull(),
		originatingStimulusId: varchar('originatingStimulusId', {
			length: 500,
		}).notNull(),
		actorVersion: int('actorVersion', { unsigned: true }).notNull(),
		ordinal: int('ordinal', { unsigned: true }).notNull(),
		intentType: varchar('intentType', { length: 64 }).notNull(),
		intent: json('intent').$type<unknown>().notNull(),
		status: varchar('status', { length: 32 }).notNull(),
		settledByStimulusId: varchar('settledByStimulusId', { length: 500 }),
		settledAt: timestamp('settledAt', { mode: 'date', fsp: 3 }),
		createdAt: timestamp('createdAt', { mode: 'date', fsp: 3 })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp('updatedAt', { mode: 'date', fsp: 3 })
			.defaultNow()
			.onUpdateNow()
			.notNull(),
	},
	(table) => ({
		journeyVersionOrdinalUq: uniqueIndex(
			'EvergreenOfferJourneyIntent_journey_version_ordinal_uq',
		).on(table.journeyId, table.actorVersion, table.ordinal),
		journeyIdIdx: index('EvergreenOfferJourneyIntent_journeyId_idx').on(
			table.journeyId,
		),
		statusIdx: index('EvergreenOfferJourneyIntent_status_idx').on(table.status),
		originatingStimulusIdx: index(
			'EvergreenOfferJourneyIntent_originatingStimulus_idx',
		).on(table.originatingStimulusId),
	}),
)

export const evergreenOfferJourneyWake = mysqlTable(
	'EvergreenOfferJourneyWake',
	{
		format: varchar('format', { length: 64 }).notNull(),
		wakeId: varchar('wakeId', { length: 500 }).notNull().primaryKey(),
		journeyId: varchar('journeyId', { length: 500 }).notNull(),
		originatingStimulusId: varchar('originatingStimulusId', {
			length: 500,
		}).notNull(),
		actorVersion: int('actorVersion', { unsigned: true }).notNull(),
		ordinal: int('ordinal', { unsigned: true }).notNull(),
		purposeType: varchar('purposeType', { length: 64 }).notNull(),
		dueAt: timestamp('dueAt', { mode: 'date', fsp: 3 }).notNull(),
		wake: json('wake').$type<unknown>().notNull(),
		status: varchar('status', { length: 32 }).notNull(),
		settledByStimulusId: varchar('settledByStimulusId', { length: 500 }),
		settledAt: timestamp('settledAt', { mode: 'date', fsp: 3 }),
		createdAt: timestamp('createdAt', { mode: 'date', fsp: 3 })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp('updatedAt', { mode: 'date', fsp: 3 })
			.defaultNow()
			.onUpdateNow()
			.notNull(),
	},
	(table) => ({
		journeyVersionOrdinalUq: uniqueIndex(
			'EvergreenOfferJourneyWake_journey_version_ordinal_uq',
		).on(table.journeyId, table.actorVersion, table.ordinal),
		journeyIdIdx: index('EvergreenOfferJourneyWake_journeyId_idx').on(
			table.journeyId,
		),
		statusDueAtIdx: index('EvergreenOfferJourneyWake_status_dueAt_idx').on(
			table.status,
			table.dueAt,
		),
		originatingStimulusIdx: index(
			'EvergreenOfferJourneyWake_originatingStimulus_idx',
		).on(table.originatingStimulusId),
	}),
)
