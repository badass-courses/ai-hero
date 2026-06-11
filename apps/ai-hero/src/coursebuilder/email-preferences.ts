import type { EmailPreferenceDefinition } from '@coursebuilder/core/providers'

export type EmailPreferenceKey = 'newsletter' | 'ai-skills'

export type AppEmailPreferenceDefinition = EmailPreferenceDefinition & {
	key: EmailPreferenceKey
	name: string
	description: string
	localPreferenceTypeName: string
}

export const emailPreferenceDefinitions = [
	{
		key: 'newsletter',
		field: 'pref_newsletter',
		defaultSubscribed: true,
		name: 'AI Hero newsletter',
		description: 'General AI Hero news, product updates, and announcements.',
		localPreferenceTypeName: 'Newsletter',
	},
	{
		key: 'ai-skills',
		field: 'pref_ai_skills_updates',
		defaultSubscribed: true,
		name: 'AI Skills updates',
		description:
			"Frequent updates about Matt Pocock's AI skills repo, examples, and releases.",
		localPreferenceTypeName: 'AI Skills Updates',
	},
] as const satisfies readonly AppEmailPreferenceDefinition[]

export const emailPreferenceDefinitionByKey = Object.fromEntries(
	emailPreferenceDefinitions.map((preference) => [preference.key, preference]),
) as Record<EmailPreferenceKey, AppEmailPreferenceDefinition>

export const DEFAULT_EMAIL_PREFERENCE_KEY =
	'newsletter' satisfies EmailPreferenceKey

export const emailPreferenceKeys = emailPreferenceDefinitions.map(
	(preference) => preference.key,
)

/**
 * Resolves an email preference key, defaulting old unsubscribe links to newsletter.
 */
export function parseEmailPreferenceKey(
	value: string | null | undefined,
): EmailPreferenceKey {
	if (value && value in emailPreferenceDefinitionByKey) {
		return value as EmailPreferenceKey
	}

	return DEFAULT_EMAIL_PREFERENCE_KEY
}
