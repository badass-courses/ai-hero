import { describe, expect, it } from 'vitest'

import { buildVideoSearchFilter, parseVideoAccess } from './video-search-filter'

const BASE =
	'has_video:=true && ((visibility:=public && state:=published) || type:=lesson)'

describe('buildVideoSearchFilter', () => {
	it('shows everyone the free videos, free-tier lessons included', () => {
		expect(buildVideoSearchFilter({ access: 'all', ownedIds: null })).toBe(
			`${BASE} && free:=true`,
		)
	})

	it('adds the lessons from courses the viewer owns', () => {
		expect(
			buildVideoSearchFilter({ access: 'all', ownedIds: ['cohort-1', 'workshop-2'] }),
		).toBe(`${BASE} && (free:=true || course_ids:=[\`cohort-1\`,\`workshop-2\`])`)
	})

	it('limits My courses to the viewer purchases', () => {
		expect(buildVideoSearchFilter({ access: 'owned', ownedIds: ['cohort-1'] })).toBe(
			`${BASE} && course_ids:=[\`cohort-1\`]`,
		)
	})

	it('matches nothing under My courses until the status arrives', () => {
		expect(buildVideoSearchFilter({ access: 'owned', ownedIds: null })).toContain(
			'course_ids:=[`__pending__`]',
		)
		expect(buildVideoSearchFilter({ access: 'owned', ownedIds: [] })).toContain(
			'course_ids:=[`__pending__`]',
		)
	})

	it('drops watched ids when hiding watched', () => {
		expect(
			buildVideoSearchFilter({
				access: 'all',
				ownedIds: null,
				hiddenIds: ['post-1', 'lesson-2'],
			}),
		).toBe(`${BASE} && free:=true && id:!=[\`post-1\`,\`lesson-2\`]`)
	})
})

describe('parseVideoAccess', () => {
	it.each([
		[null, 'all'],
		['owned', 'owned'],
		['free', 'all'],
	])('reads %s as %s', (input, expected) => {
		expect(parseVideoAccess(input)).toBe(expected)
	})
})
