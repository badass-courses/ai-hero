import { mysqlTable } from '@/db/mysql-table'
import {
	int,
	json,
	primaryKey,
	timestamp,
	uniqueIndex,
	varchar,
} from 'drizzle-orm/mysql-core'

export const emailCourseCommit = mysqlTable(
	'EmailCourseCommit',
	{
		runId: varchar('runId', { length: 500 }).notNull(),
		actorVersion: int('actorVersion', { unsigned: true }).notNull(),
		stimulusId: varchar('stimulusId', { length: 500 }).notNull(),
		snapshot: json('snapshot').$type<unknown>().notNull(),
		decision: json('decision').$type<unknown>().notNull(),
		events: json('events').$type<unknown>().notNull(),
		receipt: json('receipt').$type<unknown>().notNull(),
		decidedAt: timestamp('decidedAt', { mode: 'date', fsp: 3 }).notNull(),
		committedAt: timestamp('committedAt', { mode: 'date', fsp: 3 })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		runVersionPk: primaryKey({
			columns: [table.runId, table.actorVersion],
		}),
		stimulusIdUq: uniqueIndex('EmailCourseCommit_stimulusId_uq').on(
			table.stimulusId,
		),
	}),
)

/**
 * A missing row means stopped. The JSON value is restored through the typed
 * Email Course control codec before any caller can treat the automation as on.
 */
export const automationControl = mysqlTable('AutomationControl', {
	automationId: varchar('automationId', { length: 255 }).notNull().primaryKey(),
	control: json('control').$type<unknown>().notNull(),
	updatedAt: timestamp('updatedAt', { mode: 'date', fsp: 3 })
		.defaultNow()
		.onUpdateNow()
		.notNull(),
})
