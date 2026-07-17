import { mysqlTable } from '@/db/mysql-table'
import { relations } from 'drizzle-orm'
import {
	boolean,
	decimal,
	index,
	int,
	json,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from 'drizzle-orm/mysql-core'

import { getCourseBuilderSchema } from '@coursebuilder/adapter-drizzle/mysql'
import { guid } from '@coursebuilder/utils/guid'

export const {
	accounts,
	accountsRelations,
	profiles,
	profilesRelations,
	permissions,
	permissionsRelations,
	rolePermissions,
	rolePermissionsRelations,
	roles,
	rolesRelations,
	sessions,
	sessionsRelations,
	userPermissions,
	userPermissionsRelations,
	userRoles,
	userRolesRelations,
	users,
	usersRelations,
	verificationTokens,
	coupon,
	couponRelations,
	merchantAccount,
	merchantCharge,
	merchantChargeRelations,
	merchantEvents,
	merchantEventsRelations,
	merchantCoupon,
	merchantCustomer,
	merchantPrice,
	merchantProduct,
	merchantSession,
	prices,
	products,
	productRelations,
	purchases,
	purchaseRelations,
	purchaseUserTransfer,
	purchaseUserTransferRelations,
	communicationChannel,
	communicationPreferenceTypes,
	communicationPreferences,
	communicationPreferencesRelations,
	contentContributions,
	contentContributionRelations,
	contentResource,
	contentResourceRelations,
	contentResourceTag,
	contentResourceTagRelations,
	tag,
	tagRelations,
	tagTag,
	tagTagRelations,
	contentResourceVersion,
	contentResourceVersionRelations,
	contentResourceResource,
	contentResourceResourceRelations,
	contributionTypes,
	contributionTypesRelations,
	resourceProgress,
	questionResponse,
	questionResponseRelations,
	contentResourceProduct,
	contentResourceProductRelations,
	upgradableProducts,
	upgradableProductsRelations,
	comments,
	commentsRelations,
	userPrefs,
	userPrefsRelations,
	organization,
	organizationRelations,
	organizationMemberships,
	organizationMembershipRelations,
	organizationMembershipRoles,
	organizationMembershipRolesRelations,
	merchantSubscription,
	merchantSubscriptionRelations,
	subscription,
	subscriptionRelations,
	deviceVerifications,
	deviceVerificationRelations,
	deviceAccessToken,
	deviceAccessTokenRelations,
	personalAccessToken,
	personalAccessTokenRelations,
	entitlements,
	entitlementsRelations,
	entitlementTypes,
} = getCourseBuilderSchema(mysqlTable)

/**
 * Shortlink table for URL shortening
 */
export const shortlink = mysqlTable('Shortlink', {
	id: varchar('id', { length: 255 })
		.notNull()
		.primaryKey()
		.$defaultFn(() => guid()),
	slug: varchar('slug', { length: 50 }).notNull().unique(),
	url: text('url').notNull(),
	description: varchar('description', { length: 255 }),
	metadata: json('metadata').$type<Record<string, unknown>>(),
	clicks: int('clicks').default(0).notNull(),
	createdById: varchar('createdById', { length: 255 }),
	createdAt: timestamp('createdAt').defaultNow().notNull(),
	updatedAt: timestamp('updatedAt').defaultNow().notNull(),
})

export const shortlinkRelations = relations(shortlink, ({ one, many }) => ({
	createdBy: one(users, {
		fields: [shortlink.createdById],
		references: [users.id],
	}),
	clicks: many(shortlinkClick),
	attributions: many(shortlinkAttribution),
}))

/**
 * Shortlink click events for analytics
 */
export const shortlinkClick = mysqlTable('ShortlinkClick', {
	id: varchar('id', { length: 255 })
		.notNull()
		.primaryKey()
		.$defaultFn(() => guid()),
	shortlinkId: varchar('shortlinkId', { length: 255 }).notNull(),
	timestamp: timestamp('timestamp').defaultNow().notNull(),
	referrer: varchar('referrer', { length: 500 }),
	userAgent: varchar('userAgent', { length: 500 }),
	country: varchar('country', { length: 2 }),
	device: varchar('device', { length: 50 }),
	metadata: json('metadata').$type<Record<string, unknown>>(),
})

export const shortlinkClickRelations = relations(shortlinkClick, ({ one }) => ({
	shortlink: one(shortlink, {
		fields: [shortlinkClick.shortlinkId],
		references: [shortlink.id],
	}),
}))

/**
 * Shortlink attribution tracking for signups/purchases
 */
export const shortlinkAttribution = mysqlTable('ShortlinkAttribution', {
	id: varchar('id', { length: 255 })
		.notNull()
		.primaryKey()
		.$defaultFn(() => guid()),
	shortlinkId: varchar('shortlinkId', { length: 255 }).notNull(),
	userId: varchar('userId', { length: 255 }),
	email: varchar('email', { length: 255 }),
	type: varchar('type', { length: 50 }).notNull(),
	metadata: text('metadata'),
	createdAt: timestamp('createdAt').defaultNow().notNull(),
})

export const shortlinkAttributionRelations = relations(
	shortlinkAttribution,
	({ one }) => ({
		shortlink: one(shortlink, {
			fields: [shortlinkAttribution.shortlinkId],
			references: [shortlink.id],
		}),
		user: one(users, {
			fields: [shortlinkAttribution.userId],
			references: [users.id],
		}),
	}),
)

/**
 * Staged content read signals for gated subscriber marketing attribution.
 */
export const contentRead = mysqlTable(
	'ContentRead',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		sessionId: varchar('sessionId', { length: 255 }).notNull(),
		contactId: varchar('contactId', { length: 255 }),
		userId: varchar('userId', { length: 255 }),
		kitSubscriberId: varchar('kitSubscriberId', { length: 255 }),
		emailSha256: varchar('emailSha256', { length: 64 }),
		contentId: varchar('contentId', { length: 255 }).notNull(),
		contentSlug: varchar('contentSlug', { length: 255 }).notNull(),
		contentType: varchar('contentType', { length: 100 }).notNull(),
		parentSlug: varchar('parentSlug', { length: 255 }),
		readSignal: varchar('readSignal', { length: 50 }).notNull(),
		sourceShortlinkSlug: varchar('sourceShortlinkSlug', { length: 50 }),
		shortlinkMetadata:
			json('shortlinkMetadata').$type<Record<string, unknown>>(),
		firstTouch: json('firstTouch').$type<Record<string, unknown>>(),
		contentMetadata: json('contentMetadata')
			.$type<Record<string, unknown>>()
			.notNull(),
		pathname: varchar('pathname', { length: 500 }).notNull(),
		referrer: varchar('referrer', { length: 500 }),
		userAgent: varchar('userAgent', { length: 500 }),
		country: varchar('country', { length: 2 }),
		clientEventId: varchar('clientEventId', { length: 128 }).notNull(),
		semanticIdempotencyKey: varchar('semanticIdempotencyKey', {
			length: 500,
		}).notNull(),
		occurredAt: timestamp('occurredAt').notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		semanticIdempotencyKeyUq: uniqueIndex(
			'ContentRead_semanticIdempotencyKey_uq',
		).on(table.semanticIdempotencyKey),
		sessionIdIdx: index('ContentRead_sessionId_idx').on(table.sessionId),
		contactIdIdx: index('ContentRead_contactId_idx').on(table.contactId),
		kitSubscriberIdIdx: index('ContentRead_kitSubscriberId_idx').on(
			table.kitSubscriberId,
		),
		emailSha256Idx: index('ContentRead_emailSha256_idx').on(table.emailSha256),
		contentIdIdx: index('ContentRead_contentId_idx').on(table.contentId),
		occurredAtIdx: index('ContentRead_occurredAt_idx').on(table.occurredAt),
		sourceShortlinkSlugIdx: index('ContentRead_sourceShortlinkSlug_idx').on(
			table.sourceShortlinkSlug,
		),
	}),
)

/**
 * AI Hero Subscriber Marketing Automation Gate A durable shapes.
 * Logical names are intentionally unprefixed; mysqlTable adds AI_.
 */
export const contact = mysqlTable(
	'Contact',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		userId: varchar('userId', { length: 255 }),
		email: varchar('email', { length: 255 }),
		name: varchar('name', { length: 255 }),
		lifecycle: varchar('lifecycle', { length: 50 }).notNull().default('new'),
		isProvisional: boolean('isProvisional').notNull().default(true),
		optInAttribution: json('optInAttribution').$type<Record<string, unknown>>(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt').defaultNow().notNull(),
	},
	(table) => ({
		userIdIdx: index('Contact_userId_idx').on(table.userId),
		emailIdx: index('Contact_email_idx').on(table.email),
		lifecycleIdx: index('Contact_lifecycle_idx').on(table.lifecycle),
	}),
)

export const providerIdentity = mysqlTable(
	'ProviderIdentity',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		provider: varchar('provider', { length: 50 }).notNull(),
		externalId: varchar('externalId', { length: 255 }).notNull(),
		evidence: json('evidence').$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt').defaultNow().notNull(),
	},
	(table) => ({
		providerExternalIdUq: uniqueIndex(
			'ProviderIdentity_provider_externalId_uq',
		).on(table.provider, table.externalId),
		contactIdIdx: index('ProviderIdentity_contactId_idx').on(table.contactId),
		providerIdx: index('ProviderIdentity_provider_idx').on(table.provider),
	}),
)

export const contactLink = mysqlTable(
	'ContactLink',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		userId: varchar('userId', { length: 255 }).notNull(),
		reason: varchar('reason', { length: 255 }).notNull(),
		evidence: json('evidence').$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		contactIdIdx: index('ContactLink_contactId_idx').on(table.contactId),
		userIdIdx: index('ContactLink_userId_idx').on(table.userId),
		contactUserUq: uniqueIndex('ContactLink_contact_user_uq').on(
			table.contactId,
			table.userId,
		),
	}),
)

export const contactEvent = mysqlTable(
	'ContactEvent',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
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
		privacyLevel: varchar('privacyLevel', { length: 50 }).notNull(),
		identityEvidence: json('identityEvidence')
			.$type<Record<string, unknown>>()
			.notNull(),
		payloadSummary: json('payloadSummary')
			.$type<Record<string, unknown>>()
			.notNull(),
		schemaVersion: int('schemaVersion').notNull(),
		occurredAt: timestamp('occurredAt').notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		semanticIdempotencyKeyUq: uniqueIndex(
			'ContactEvent_semanticIdempotencyKey_uq',
		).on(table.semanticIdempotencyKey),
		contactIdIdx: index('ContactEvent_contactId_idx').on(table.contactId),
		providerIdentityIdIdx: index('ContactEvent_providerIdentityId_idx').on(
			table.providerIdentityId,
		),
		providerReferenceIdx: index('ContactEvent_providerReference_idx').on(
			table.provider,
			table.providerEventId,
		),
		occurredAtIdx: index('ContactEvent_occurredAt_idx').on(table.occurredAt),
	}),
)

export const contactState = mysqlTable(
	'ContactState',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		lifecycle: varchar('lifecycle', { length: 50 }).notNull(),
		primaryBucket: varchar('primaryBucket', { length: 150 }).notNull(),
		allBuckets: json('allBuckets').$type<string[]>().notNull(),
		whySignals: json('whySignals').$type<string[]>().notNull(),
		whoSignals: json('whoSignals').$type<string[]>().notNull(),
		confidence: decimal('confidence', { precision: 5, scale: 4 }).notNull(),
		rationale: json('rationale').$type<string[]>().notNull(),
		reviewSignals: json('reviewSignals').$type<string[]>().notNull(),
		humanReview: boolean('humanReview').notNull().default(false),
		optInAttribution: json('optInAttribution').$type<Record<string, unknown>>(),
		lastEventId: varchar('lastEventId', { length: 255 }).notNull(),
		schemaVersion: int('schemaVersion').notNull(),
		updatedAt: timestamp('updatedAt').defaultNow().notNull(),
	},
	(table) => ({
		contactIdUq: uniqueIndex('ContactState_contactId_uq').on(table.contactId),
		primaryBucketIdx: index('ContactState_primaryBucket_idx').on(
			table.primaryBucket,
		),
		lastEventIdIdx: index('ContactState_lastEventId_idx').on(table.lastEventId),
	}),
)

export const stateTransition = mysqlTable(
	'StateTransition',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		fromStateId: varchar('fromStateId', { length: 255 }),
		toStateId: varchar('toStateId', { length: 255 }).notNull(),
		eventId: varchar('eventId', { length: 255 }).notNull(),
		signals: json('signals').$type<Record<string, unknown>>().notNull(),
		rationale: json('rationale').$type<string[]>().notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		contactIdIdx: index('StateTransition_contactId_idx').on(table.contactId),
		eventIdIdx: index('StateTransition_eventId_idx').on(table.eventId),
		toStateIdIdx: index('StateTransition_toStateId_idx').on(table.toStateId),
	}),
)

export const nextAction = mysqlTable(
	'NextAction',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		contactStateId: varchar('contactStateId', { length: 255 }).notNull(),
		eventId: varchar('eventId', { length: 255 }).notNull(),
		type: varchar('type', { length: 100 }).notNull(),
		status: varchar('status', { length: 50 }).notNull(),
		gates: json('gates').$type<Record<string, unknown>[]>().notNull(),
		reviewReasons: json('reviewReasons').$type<string[]>().notNull(),
		rationale: json('rationale').$type<string[]>().notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		contactIdIdx: index('NextAction_contactId_idx').on(table.contactId),
		contactStateIdIdx: index('NextAction_contactStateId_idx').on(
			table.contactStateId,
		),
		eventIdIdx: index('NextAction_eventId_idx').on(table.eventId),
		statusIdx: index('NextAction_status_idx').on(table.status),
	}),
)

export const sideEffectIntent = mysqlTable(
	'SideEffectIntent',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		nextActionId: varchar('nextActionId', { length: 255 }).notNull(),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		provider: varchar('provider', { length: 50 }).notNull(),
		type: varchar('type', { length: 100 }).notNull(),
		status: varchar('status', { length: 50 }).notNull(),
		idempotencyKey: varchar('idempotencyKey', { length: 500 }).notNull(),
		gates: json('gates').$type<Record<string, unknown>[]>().notNull(),
		reviewReasons: json('reviewReasons').$type<string[]>().notNull(),
		metadata: json('metadata').$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
	},
	(table) => ({
		idempotencyKeyUq: uniqueIndex('SideEffectIntent_idempotencyKey_uq').on(
			table.idempotencyKey,
		),
		nextActionIdIdx: index('SideEffectIntent_nextActionId_idx').on(
			table.nextActionId,
		),
		contactIdIdx: index('SideEffectIntent_contactId_idx').on(table.contactId),
		statusIdx: index('SideEffectIntent_status_idx').on(table.status),
	}),
)

export const googleAdsConversionUpload = mysqlTable(
	'GoogleAdsConversionUpload',
	{
		id: varchar('id', { length: 255 })
			.notNull()
			.primaryKey()
			.$defaultFn(() => guid()),
		purchaseId: varchar('purchaseId', { length: 255 }).notNull(),
		conversionActionResourceName: varchar('conversionActionResourceName', {
			length: 255,
		}).notNull(),
		clickIdType: varchar('clickIdType', { length: 20 }).notNull(),
		clickIdHash: varchar('clickIdHash', { length: 64 }).notNull(),
		attributionSource: varchar('attributionSource', { length: 40 })
			.notNull()
			.default('checkout'),
		conversionDateTime: varchar('conversionDateTime', { length: 40 }).notNull(),
		conversionValue: decimal('conversionValue', {
			precision: 12,
			scale: 2,
		}).notNull(),
		currencyCode: varchar('currencyCode', { length: 3 }).notNull(),
		orderId: varchar('orderId', { length: 255 }).notNull(),
		status: varchar('status', { length: 40 }).notNull(),
		attemptCount: int('attemptCount').notNull().default(0),
		idempotencyKey: varchar('idempotencyKey', { length: 500 }).notNull(),
		requestSummary: json('requestSummary')
			.$type<Record<string, unknown>>()
			.notNull(),
		responseSummary: json('responseSummary').$type<Record<string, unknown>>(),
		lastError: json('lastError').$type<Record<string, unknown>>(),
		lastAttemptAt: timestamp('lastAttemptAt'),
		uploadedAt: timestamp('uploadedAt'),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
	},
	(table) => ({
		idempotencyKeyUq: uniqueIndex(
			'GoogleAdsConversionUpload_idempotencyKey_uq',
		).on(table.idempotencyKey),
		purchaseIdIdx: index('GoogleAdsConversionUpload_purchaseId_idx').on(
			table.purchaseId,
		),
		statusIdx: index('GoogleAdsConversionUpload_status_idx').on(table.status),
		conversionActionIdx: index(
			'GoogleAdsConversionUpload_conversionAction_idx',
		).on(table.conversionActionResourceName),
	}),
)

export const googleAdsSignupConversionUpload = mysqlTable(
	'GoogleAdsSignupConversionUpload',
	{
		id: varchar('id', { length: 255 }).notNull().primaryKey().$defaultFn(() => guid()),
		contactId: varchar('contactId', { length: 255 }).notNull(),
		conversionActionResourceName: varchar('conversionActionResourceName', { length: 255 }).notNull(),
		clickIdType: varchar('clickIdType', { length: 20 }).notNull(),
		clickIdHash: varchar('clickIdHash', { length: 64 }).notNull(),
		conversionDateTime: varchar('conversionDateTime', { length: 40 }).notNull(),
		status: varchar('status', { length: 40 }).notNull(),
		attemptCount: int('attemptCount').notNull().default(0),
		idempotencyKey: varchar('idempotencyKey', { length: 500 }).notNull(),
		requestSummary: json('requestSummary').$type<Record<string, unknown>>().notNull(),
		responseSummary: json('responseSummary').$type<Record<string, unknown>>(),
		createdAt: timestamp('createdAt').defaultNow().notNull(),
		updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
	},
	(table) => ({
		idempotencyKeyUq: uniqueIndex('GoogleAdsSignupConversionUpload_idempotencyKey_uq').on(table.idempotencyKey),
		contactIdIdx: index('GoogleAdsSignupConversionUpload_contactId_idx').on(table.contactId),
		statusIdx: index('GoogleAdsSignupConversionUpload_status_idx').on(table.status),
	}),
)

export const contactRelations = relations(contact, ({ many, one }) => ({
	user: one(users, { fields: [contact.userId], references: [users.id] }),
	providerIdentities: many(providerIdentity),
	events: many(contactEvent),
	state: one(contactState),
	links: many(contactLink),
	nextActions: many(nextAction),
	sideEffectIntents: many(sideEffectIntent),
}))

export const providerIdentityRelations = relations(
	providerIdentity,
	({ one, many }) => ({
		contact: one(contact, {
			fields: [providerIdentity.contactId],
			references: [contact.id],
		}),
		events: many(contactEvent),
	}),
)

export const contactLinkRelations = relations(contactLink, ({ one }) => ({
	contact: one(contact, {
		fields: [contactLink.contactId],
		references: [contact.id],
	}),
	user: one(users, {
		fields: [contactLink.userId],
		references: [users.id],
	}),
}))

export const contactEventRelations = relations(
	contactEvent,
	({ one, many }) => ({
		contact: one(contact, {
			fields: [contactEvent.contactId],
			references: [contact.id],
		}),
		providerIdentity: one(providerIdentity, {
			fields: [contactEvent.providerIdentityId],
			references: [providerIdentity.id],
		}),
		transitions: many(stateTransition),
		nextActions: many(nextAction),
	}),
)

export const contactStateRelations = relations(
	contactState,
	({ one, many }) => ({
		contact: one(contact, {
			fields: [contactState.contactId],
			references: [contact.id],
		}),
		lastEvent: one(contactEvent, {
			fields: [contactState.lastEventId],
			references: [contactEvent.id],
		}),
		nextActions: many(nextAction),
	}),
)

export const stateTransitionRelations = relations(
	stateTransition,
	({ one }) => ({
		contact: one(contact, {
			fields: [stateTransition.contactId],
			references: [contact.id],
		}),
		event: one(contactEvent, {
			fields: [stateTransition.eventId],
			references: [contactEvent.id],
		}),
		toState: one(contactState, {
			fields: [stateTransition.toStateId],
			references: [contactState.id],
		}),
	}),
)

export const nextActionRelations = relations(nextAction, ({ one, many }) => ({
	contact: one(contact, {
		fields: [nextAction.contactId],
		references: [contact.id],
	}),
	contactState: one(contactState, {
		fields: [nextAction.contactStateId],
		references: [contactState.id],
	}),
	event: one(contactEvent, {
		fields: [nextAction.eventId],
		references: [contactEvent.id],
	}),
	sideEffectIntents: many(sideEffectIntent),
}))

export const sideEffectIntentRelations = relations(
	sideEffectIntent,
	({ one }) => ({
		contact: one(contact, {
			fields: [sideEffectIntent.contactId],
			references: [contact.id],
		}),
		nextAction: one(nextAction, {
			fields: [sideEffectIntent.nextActionId],
			references: [nextAction.id],
		}),
	}),
)
