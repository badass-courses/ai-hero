import { createHash } from 'node:crypto'
import { cache } from 'react'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import {
	emailPreferenceDefinitionByKey,
	emailPreferenceDefinitions,
	type AppEmailPreferenceDefinition,
	type EmailPreferenceKey,
} from '@/coursebuilder/email-preferences'
import { db } from '@/db'
import { communicationPreferences, users as usersTable } from '@/db/schema'
import { log, serializeError } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { guid } from '@coursebuilder/utils/guid'
import { eq } from 'drizzle-orm'

type Subscriber = {
	id: string | number
	email_address?: string | null
	fields?: Record<string, string | null>
}

type PreferenceSource =
	| 'preferences-page'
	| 'unsubscribe-link'
	| 'broadcast-guard'
	| 'admin'
	| 'cli'

type User = typeof usersTable.$inferSelect

const EMAIL_PREFERENCE_PROVIDER = 'convertkit'

/**
 * Normalizes an email address before hashing or provider lookup.
 */
export function normalizeEmailForPreferenceHash(email: string) {
	return email.trim().toLowerCase()
}

/**
 * Creates the SHA-256 email hash Kit sends as `sh_kit`.
 */
export function hashEmailForKit(email: string) {
	return createHash('sha256')
		.update(normalizeEmailForPreferenceHash(email))
		.digest('hex')
}

/**
 * Reads a string value from Next search params.
 */
export function getSearchParamValue(
	value: string | string[] | undefined,
): string | undefined {
	return Array.isArray(value) ? value[0] : value
}

/**
 * Fetches a ConvertKit subscriber with slow-call tracing.
 */
export const getEmailPreferenceSubscriber = cache(
	async ({
		subscriberId,
		subscriberEmail,
		source,
	}: {
		subscriberId?: string
		subscriberEmail?: string
		source: PreferenceSource
	}) => {
		const subscriber = await measureIfSlow({
			event: 'email-preferences.provider.read.slow',
			spanName: 'email-preferences.provider.read',
			thresholdMs: 750,
			data: {
				source,
				provider: EMAIL_PREFERENCE_PROVIDER,
				kitSubscriberId: subscriberId,
				hasSubscriberEmail: Boolean(subscriberEmail),
			},
			operation: async () =>
				subscriberId
					? (emailListProvider.getSubscriber(
							subscriberId,
						) as Promise<Subscriber | null>)
					: (emailListProvider.getSubscriberByEmail(
							subscriberEmail ?? '',
						) as Promise<Subscriber | null>),
		})

		return subscriber
	},
)

/**
 * Validates Kit's appended subscriber id and hashed email link parameters.
 */
export async function validateKitPreferenceIdentity({
	subscriberId,
	shKit,
	source,
	route,
}: {
	subscriberId?: string
	shKit?: string
	source: PreferenceSource
	route: string
}) {
	if (!subscriberId || !shKit) {
		await log.warn('email-preferences.identity.validation.failed', {
			source,
			route,
			provider: EMAIL_PREFERENCE_PROVIDER,
			kitSubscriberId: subscriberId,
			shKit,
			reason: 'missing-kit-params',
		})
		return null
	}

	const subscriber = await getEmailPreferenceSubscriber({
		subscriberId,
		source,
	})

	if (!subscriber?.email_address) {
		await log.warn('email-preferences.identity.validation.failed', {
			source,
			route,
			provider: EMAIL_PREFERENCE_PROVIDER,
			kitSubscriberId: subscriberId,
			shKit,
			reason: 'subscriber-not-found',
		})
		return null
	}

	const expectedHash = hashEmailForKit(subscriber.email_address)

	if (expectedHash !== shKit) {
		await log.warn('email-preferences.identity.validation.failed', {
			source,
			route,
			provider: EMAIL_PREFERENCE_PROVIDER,
			kitSubscriberId: subscriberId,
			shKit,
			reason: 'hash-mismatch',
		})
		return null
	}

	return subscriber
}

/**
 * Reads provider-canonical email preference state.
 */
export async function getProviderEmailPreferences({
	subscriberId,
	subscriberEmail,
	source,
}: {
	subscriberId?: string
	subscriberEmail?: string
	source: PreferenceSource
}) {
	if (!emailListProvider.getSubscriberPreferences) {
		throw new Error('Email list provider does not support preferences')
	}

	return measureIfSlow({
		event: 'email-preferences.provider.read.slow',
		spanName: 'email-preferences.provider.preferences.read',
		thresholdMs: 750,
		data: {
			source,
			provider: EMAIL_PREFERENCE_PROVIDER,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
		},
		operation: async () =>
			emailListProvider.getSubscriberPreferences!({
				subscriberId,
				subscriberEmail,
				preferences: [...emailPreferenceDefinitions],
			}),
	})
}

/**
 * Updates provider-canonical preference state and logs the result.
 */
export async function updateProviderEmailPreference({
	subscriberId,
	subscriberEmail,
	preference,
	subscribed,
	source,
}: {
	subscriberId?: string
	subscriberEmail?: string
	preference: AppEmailPreferenceDefinition
	subscribed: boolean
	source: PreferenceSource
}) {
	if (!emailListProvider.updateSubscriberPreference) {
		throw new Error('Email list provider does not support preference updates')
	}

	try {
		const state = await measureIfSlow({
			event: 'email-preferences.provider.update.slow',
			spanName: 'email-preferences.provider.update',
			thresholdMs: 750,
			data: {
				source,
				provider: EMAIL_PREFERENCE_PROVIDER,
				kitSubscriberId: subscriberId,
				hasSubscriberEmail: Boolean(subscriberEmail),
				preferenceKey: preference.key,
				result: subscribed ? 'subscribed' : 'unsubscribed',
			},
			operation: async () =>
				emailListProvider.updateSubscriberPreference!({
					subscriberId,
					subscriberEmail,
					preference,
					subscribed,
				}),
		})

		await log.info('email-preferences.provider.update', {
			source,
			provider: EMAIL_PREFERENCE_PROVIDER,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
			preferenceKey: preference.key,
			result: state.status,
		})

		return state
	} catch (error) {
		await log.error('email-preferences.provider.update.failed', {
			source,
			provider: EMAIL_PREFERENCE_PROVIDER,
			kitSubscriberId: subscriberId,
			hasSubscriberEmail: Boolean(subscriberEmail),
			preferenceKey: preference.key,
			result: 'failed',
			error: serializeError(error),
		})
		throw error
	}
}

/**
 * Mirrors provider-canonical state into local communication preference rows.
 */
export async function syncLocalEmailPreference({
	email,
	preference,
	subscribed,
	source,
}: {
	email?: string | null
	preference: AppEmailPreferenceDefinition
	subscribed: boolean
	source: PreferenceSource
}) {
	if (!email) return null

	const user = await db.query.users.findFirst({
		where: (users, { eq }) => eq(users.email, email),
	})

	if (!user) {
		await log.info('email-preferences.local-mirror.sync', {
			source,
			provider: EMAIL_PREFERENCE_PROVIDER,
			preferenceKey: preference.key,
			result: 'skipped',
			reason: 'user-not-found',
		})
		return null
	}

	return syncLocalEmailPreferenceForUser({
		user,
		preference,
		subscribed,
		source,
	})
}

/**
 * Mirrors provider-canonical state for a known local user.
 */
export async function syncLocalEmailPreferenceForUser({
	user,
	preference,
	subscribed,
	source,
}: {
	user: User
	preference: AppEmailPreferenceDefinition
	subscribed: boolean
	source: PreferenceSource
}) {
	const [preferenceType, preferenceChannel] = await Promise.all([
		db.query.communicationPreferenceTypes.findFirst({
			where: (cpt, { eq }) => eq(cpt.name, preference.localPreferenceTypeName),
		}),
		db.query.communicationChannel.findFirst({
			where: (cc, { eq }) => eq(cc.name, 'Email'),
		}),
	])

	if (!preferenceType || !preferenceChannel) {
		await log.warn('email-preferences.local-mirror.sync', {
			source,
			provider: EMAIL_PREFERENCE_PROVIDER,
			userId: user.id,
			preferenceKey: preference.key,
			result: 'skipped',
			hasPreferenceType: Boolean(preferenceType),
			hasPreferenceChannel: Boolean(preferenceChannel),
		})
		return null
	}

	const existingPreference = await db.query.communicationPreferences.findFirst({
		where: (cp, { and, eq }) =>
			and(eq(cp.userId, user.id), eq(cp.preferenceTypeId, preferenceType.id)),
	})

	const now = new Date()

	if (!existingPreference) {
		await db.insert(communicationPreferences).values({
			id: guid(),
			userId: user.id,
			preferenceTypeId: preferenceType.id,
			channelId: preferenceChannel.id,
			active: subscribed,
			updatedAt: now,
			preferenceLevel: subscribed ? 'medium' : 'low',
			optInAt: subscribed ? now : null,
			optOutAt: subscribed ? null : now,
			createdAt: now,
		})
	} else {
		await db
			.update(communicationPreferences)
			.set({
				active: subscribed,
				updatedAt: now,
				preferenceLevel: subscribed ? 'medium' : 'low',
				optInAt: subscribed ? now : existingPreference.optInAt,
				optOutAt: subscribed ? existingPreference.optOutAt : now,
			})
			.where(eq(communicationPreferences.id, existingPreference.id))
	}

	await log.info('email-preferences.local-mirror.sync', {
		source,
		provider: EMAIL_PREFERENCE_PROVIDER,
		userId: user.id,
		preferenceKey: preference.key,
		result: subscribed ? 'subscribed' : 'unsubscribed',
	})

	return { userId: user.id, preferenceKey: preference.key, subscribed }
}

/**
 * Reads provider state and refreshes every matching local preference mirror.
 */
export async function syncLocalEmailPreferencesFromProvider({
	subscriberId,
	subscriberEmail,
	source,
}: {
	subscriberId?: string
	subscriberEmail?: string
	source: PreferenceSource
}) {
	const subscriber = await getEmailPreferenceSubscriber({
		subscriberId,
		subscriberEmail,
		source,
	})
	const preferences = await getProviderEmailPreferences({
		subscriberId,
		subscriberEmail: subscriberEmail ?? subscriber?.email_address ?? undefined,
		source,
	})

	for (const preference of emailPreferenceDefinitions) {
		await syncLocalEmailPreference({
			email: subscriber?.email_address ?? subscriberEmail,
			preference,
			subscribed: preferences[preference.key]?.subscribed ?? true,
			source,
		})
	}

	return { subscriber, preferences }
}

/**
 * Unsubscribes a legacy user-id link from a local preference mirror.
 */
export async function unsubscribeLocalEmailPreferenceByUserId({
	userId,
	preference,
	source,
}: {
	userId: string
	preference: AppEmailPreferenceDefinition
	source: PreferenceSource
}) {
	const user = await db.query.users.findFirst({
		where: (users, { eq }) => eq(users.id, userId),
	})

	if (!user) return null

	return syncLocalEmailPreferenceForUser({
		user,
		preference,
		subscribed: false,
		source,
	})
}

/**
 * Resolves a preference definition by key and keeps the error near callers.
 */
export function getEmailPreferenceDefinition(key: EmailPreferenceKey) {
	return emailPreferenceDefinitionByKey[key]
}
