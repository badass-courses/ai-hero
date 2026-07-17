import { describe, expect, it } from 'vitest'

import { createAppAbility } from '@/ability'
import { getContentReadFilters } from '@/lib/content-read-policy'
import { sanitizeResourcePayload } from '@/lib/resource-api-sanitizer'
import { buildTypesenseContentFilter } from '@/lib/typesense-content-filter'
import { buildPersonalAccessTokenAbility } from '@/server/pat-scopes'

describe('privileged agent content reads', () => {
	it('removes capability-bearing Mux identifiers at every resource depth', () => {
		const createdAt = new Date('2026-07-17T12:00:00.000Z')
		const sanitized = sanitizeResourcePayload({
			id: 'lesson_1',
			createdAt,
			fields: {
				title: 'Private lesson',
				muxAssetId: 'asset-secret',
			},
			resources: [
				{
					resource: {
						id: 'video_1',
						fields: {
							muxPlaybackId: 'playback-secret',
							transcript: 'Safe content',
						},
					},
				},
			],
		})

		expect(sanitized).toEqual({
			id: 'lesson_1',
			createdAt,
			fields: { title: 'Private lesson' },
			resources: [
				{
					resource: {
						id: 'video_1',
						fields: { transcript: 'Safe content' },
					},
				},
			],
		})
	})

	it('filters ordinary reads to published public or unlisted content', () => {
		const ability = createAppAbility([])

		expect(getContentReadFilters(ability)).toEqual({
			states: ['published'],
			visibility: ['public', 'unlisted'],
		})
		expect(buildTypesenseContentFilter({ ability, type: 'lesson' })).toBe(
			'state:=published && visibility:=public && type:=lesson',
		)
	})

	it('includes private drafts only for privileged reads', () => {
		const ability = buildPersonalAccessTokenAbility(['content:read'])

		expect(getContentReadFilters(ability)).toEqual({
			states: ['draft', 'published'],
			visibility: ['public', 'private', 'unlisted'],
		})
		expect(buildTypesenseContentFilter({ ability, type: 'lesson' })).toBe(
			'type:=lesson',
		)
		expect(buildTypesenseContentFilter({ ability })).toBeUndefined()
	})
})
