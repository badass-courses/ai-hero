import { mysqlTable } from '@/db/mysql-table'
import { index, int, json, uniqueIndex, varchar, timestamp } from 'drizzle-orm/mysql-core'

/**
 * Opt-in view of AI_ContactEvent for the disabled sequence-exhaustion slice.
 * Generic contact-event reads keep using the base schema until the reviewed
 * migration is deployed. This table is touched only behind
 * AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED.
 */
export const courseSequenceContactEvent = mysqlTable(
	'ContactEvent',
	{
		id: varchar('id', { length: 255 }).notNull().primaryKey(),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		providerIdentityId: varchar('providerIdentityId', {
			length: 255,
		}).notNull(),
		provider: varchar('provider', { length: 50 }).notNull(),
		providerEventId: varchar('providerEventId', { length: 255 }).notNull(),
		providerReference: varchar('providerReference', { length: 500 }).notNull(),
		eventType: varchar('eventType', { length: 100 }).notNull(),
		semanticIdempotencyKey: varchar('semanticIdempotencyKey', {
			length: 500,
		}).notNull(),
		domainFactKey: varchar('domainFactKey', { length: 500 }),
		payloadFormat: varchar('payloadFormat', { length: 64 }),
		domainPayload: json('domainPayload').$type<Record<string, unknown>>(),
		privacyLevel: varchar('privacyLevel', { length: 50 }).notNull(),
		identityEvidence: json('identityEvidence')
			.$type<Record<string, unknown>>()
			.notNull(),
		payloadSummary: json('payloadSummary')
			.$type<Record<string, unknown>>()
			.notNull(),
		schemaVersion: int('schemaVersion').notNull(),
		occurredAt: timestamp('occurredAt', { fsp: 3 }).notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		semanticIdempotencyKeyUq: uniqueIndex(
			'ContactEvent_semanticIdempotencyKey_uq',
		).on(table.semanticIdempotencyKey),
		domainFactKeyUq: uniqueIndex('ContactEvent_domainFactKey_uq').on(
			table.domainFactKey,
		),
		contactIdIdx: index('ContactEvent_contactId_idx').on(table.contactId),
		eventTypeOccurredAtIdIdx: index(
			'ContactEvent_eventType_occurredAt_id_idx',
		).on(table.eventType, table.occurredAt, table.id),
	}),
)
