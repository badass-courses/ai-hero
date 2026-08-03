import { describe, expect, it } from 'vitest'

import {
	buildPersonalAccessTokenAbility,
	canCreateContentDraft,
	canCreateShortlink,
	canMutateContentDraft,
	canUpdateContentRelation,
	canPublishContent,
	canUploadMedia,
} from '@/server/pat-scopes'

const scopeRoutes = [
	{
		scope: 'content:write',
		route: 'POST /api/posts',
		allows: canCreateContentDraft,
	},
	{
		scope: 'content:publish',
		route: 'PUT /api/posts?action=publish',
		allows: canPublishContent,
	},
	{
		scope: 'content:relations',
		route: 'POST /api/tags/attach',
		allows: canUpdateContentRelation,
	},
	{
		scope: 'media:upload',
		route: 'POST /api/uploads/multipart/create',
		allows: canUploadMedia,
	},
	{
		scope: 'shortlinks:manage',
		route: 'POST /api/shortlinks',
		allows: canCreateShortlink,
	},
] as const

describe('PAT write scope route matrix', () => {
	it.each(scopeRoutes)('$scope allows $route and no sibling route', (row) => {
		const ability = buildPersonalAccessTokenAbility([row.scope])

		for (const candidate of scopeRoutes) {
			expect(candidate.allows(ability), candidate.route).toBe(
				candidate.scope === row.scope,
			)
		}
	})

	it('lets content:write edit drafts but never published content', () => {
		const ability = buildPersonalAccessTokenAbility(['content:write'])

		expect(
			canMutateContentDraft(ability, {
				id: 'draft_1',
				fields: { state: 'draft' },
			}),
		).toBe(true)
		expect(
			canMutateContentDraft(ability, {
				id: 'published_1',
				fields: { state: 'published' },
			}),
		).toBe(false)
	})

	it('keeps broad content, admin, customer, commerce, and survey abilities out', () => {
		const ability = buildPersonalAccessTokenAbility(
			scopeRoutes.map(({ scope }) => scope),
		)

		expect(ability.cannot('manage', 'all')).toBe(true)
		expect(ability.cannot('create', 'Content')).toBe(true)
		expect(ability.cannot('update', 'Content')).toBe(true)
		expect(ability.cannot('delete', 'Content')).toBe(true)
		expect(ability.cannot('manage', 'User')).toBe(true)
		expect(ability.cannot('read', 'Analytics')).toBe(true)
		expect(ability.cannot('read', 'Entitlement')).toBe(true)
	})

	it('ignores unknown or absent persisted scopes', () => {
		for (const scopes of [[], ['unknown:scope']]) {
			const ability = buildPersonalAccessTokenAbility(scopes)

			expect(ability.cannot('read', 'Content')).toBe(true)
			expect(ability.cannot('create', 'ContentDraft')).toBe(true)
			expect(ability.cannot('manage', 'all')).toBe(true)
		}
	})
})
