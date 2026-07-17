import { AbilityBuilder, createMongoAbility } from '@casl/ability'

import { createAppAbility, type AppAbility } from '@/ability'
import type { PersonalAccessTokenScope } from '@/lib/personal-access-tokens'

export const CONTENT_READ_SCOPE =
	'content:read' as const satisfies PersonalAccessTokenScope

type PersonalAccessTokenRuleBuilder = (
	builder: AbilityBuilder<AppAbility>,
) => void

/**
 * Scope-to-CASL registry for personal access tokens.
 *
 * Analytics scopes remain deliberately dormant until their own coverage matrix
 * is approved. A no-op is safer than silently inheriting the token owner's
 * roles or broadening analytics access as a side effect of content PATs.
 */
export const personalAccessTokenScopeRegistry = {
	'analytics:read': () => undefined,
	'analytics:chat': () => undefined,
	[CONTENT_READ_SCOPE]: ({ can }) => {
		can('read', 'Content')
		can('read_privileged', 'Content')
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
