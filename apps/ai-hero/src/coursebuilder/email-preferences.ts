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

/**
 * Cohort-update opt-outs are handled by a Kit link rule that tags the
 * subscriber on click, so the unsubscribe page only confirms them. `ohort-004`
 * is the typo shipped in the Cohort 004 broadcast template. `cohort-005` and
 * later are deliberately not matched; add them here once decided.
 */
export const COHORT_UPDATES_PREFERENCES = [
	'cohorts',
	'cohort-004',
	'ohort-004',
] as const

export type UnsubscribePreferenceResolution =
	| { kind: 'cohort-updates' }
	| { kind: 'known'; key: EmailPreferenceKey }
	| { kind: 'unknown'; raw: string }

/**
 * Resolves the `preference` param of an unsubscribe link. A missing value is a
 * legacy link and means the newsletter. Any other unrecognised value is
 * `unknown` and must never fall back to an all-stop.
 */
export function resolveUnsubscribePreference(
	value: string | null | undefined,
): UnsubscribePreferenceResolution {
	const raw = value?.trim()
	if (!raw) {
		return { kind: 'known', key: DEFAULT_EMAIL_PREFERENCE_KEY }
	}
	if ((COHORT_UPDATES_PREFERENCES as readonly string[]).includes(raw)) {
		return { kind: 'cohort-updates' }
	}
	if (Object.hasOwn(emailPreferenceDefinitionByKey, raw)) {
		return { kind: 'known', key: raw as EmailPreferenceKey }
	}
	return { kind: 'unknown', raw }
}
