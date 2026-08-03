import { AbilityBuilder, createMongoAbility, subject } from '@casl/ability'

import { createAppAbility, type AppAbility } from '@/ability'
import type { PersonalAccessTokenScope } from '@/lib/personal-access-tokens'

export const CONTENT_READ_SCOPE =
	'content:read' as const satisfies PersonalAccessTokenScope
export const CONTENT_WRITE_SCOPE =
	'content:write' as const satisfies PersonalAccessTokenScope
export const CONTENT_PUBLISH_SCOPE =
	'content:publish' as const satisfies PersonalAccessTokenScope
export const CONTENT_RELATIONS_SCOPE =
	'content:relations' as const satisfies PersonalAccessTokenScope
export const MEDIA_UPLOAD_SCOPE =
	'media:upload' as const satisfies PersonalAccessTokenScope
export const SHORTLINKS_MANAGE_SCOPE =
	'shortlinks:manage' as const satisfies PersonalAccessTokenScope

type PersonalAccessTokenRuleBuilder = (
	builder: AbilityBuilder<AppAbility>,
) => void

type ScopeAbility = {
	can(action: string, subject: unknown): boolean
}

/**
 * Scope-to-CASL registry for personal access tokens.
 *
 * Write scopes use route-specific subjects instead of broad Content abilities.
 * Existing session and device-token abilities keep using Content/all. This keeps
 * PAT rules from opening unrelated routes that happen to require create/update
 * Content, such as surveys, products, support memory, or token administration.
 * Analytics scopes remain dormant until their own coverage matrix is approved.
 */
export const personalAccessTokenScopeRegistry = {
	'analytics:read': () => undefined,
	'analytics:chat': () => undefined,
	[CONTENT_READ_SCOPE]: ({ can }) => {
		can('read', 'Content')
		can('read_privileged', 'Content')
	},
	[CONTENT_WRITE_SCOPE]: ({ can }) => {
		can('create', 'ContentDraft')
		can('update', 'ContentDraft')
	},
	[CONTENT_PUBLISH_SCOPE]: ({ can }) => {
		can('publish', 'Content')
	},
	[CONTENT_RELATIONS_SCOPE]: ({ can }) => {
		can('manage', 'ContentRelation')
	},
	[MEDIA_UPLOAD_SCOPE]: ({ can }) => {
		can('create', 'MediaUpload')
	},
	[SHORTLINKS_MANAGE_SCOPE]: ({ can }) => {
		can('manage', 'Shortlink')
	},
} satisfies Record<PersonalAccessTokenScope, PersonalAccessTokenRuleBuilder>

export function buildPersonalAccessTokenAbility(scopes: string[]): AppAbility {
	const builder = new AbilityBuilder<AppAbility>(createMongoAbility)

	for (const scope of scopes) {
		if (isPersonalAccessTokenScope(scope)) {
			personalAccessTokenScopeRegistry[scope](builder)
		}
	}

	return createAppAbility(builder.rules)
}

export function isPersonalAccessTokenScope(
	scope: string,
): scope is PersonalAccessTokenScope {
	return Object.hasOwn(personalAccessTokenScopeRegistry, scope)
}

export function canCreateContentDraft(ability: ScopeAbility) {
	return (
		ability.can('create', 'Content') || ability.can('create', 'ContentDraft')
	)
}

export function canUpdateContentDraft(ability: ScopeAbility) {
	return (
		ability.can('update', 'Content') || ability.can('update', 'ContentDraft')
	)
}

export function canMutateContentDraft(
	ability: ScopeAbility,
	content: Record<string, unknown>,
) {
	const state = (content.fields as { state?: unknown } | undefined)?.state
	return (
		ability.can('manage', subject('Content', content)) ||
		(ability.can('update', 'ContentDraft') && state === 'draft')
	)
}

export function canPublishContent(
	ability: ScopeAbility,
	content?: Record<string, unknown>,
) {
	return (
		(content
			? ability.can('manage', subject('Content', content))
			: ability.can('update', 'Content')) || ability.can('publish', 'Content')
	)
}

export function canCreateContentRelation(ability: ScopeAbility) {
	return (
		ability.can('create', 'Content') || ability.can('manage', 'ContentRelation')
	)
}

export function canUpdateContentRelation(ability: ScopeAbility) {
	return (
		ability.can('update', 'Content') || ability.can('manage', 'ContentRelation')
	)
}

export function canUploadMedia(ability: ScopeAbility) {
	return (
		ability.can('create', 'Content') || ability.can('create', 'MediaUpload')
	)
}

export function canManageShortlinks(ability: ScopeAbility) {
	return ability.can('manage', 'all') || ability.can('manage', 'Shortlink')
}

export function canCreateShortlink(ability: ScopeAbility) {
	return ability.can('create', 'Content') || ability.can('manage', 'Shortlink')
}

export function canUpdateShortlink(ability: ScopeAbility) {
	return ability.can('update', 'Content') || ability.can('manage', 'Shortlink')
}

export function canDeleteShortlink(ability: ScopeAbility) {
	return ability.can('delete', 'Content') || ability.can('manage', 'Shortlink')
}
