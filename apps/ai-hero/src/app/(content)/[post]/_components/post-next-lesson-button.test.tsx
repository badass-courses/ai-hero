import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/get-nextup-resource-from-list', () => ({
	getNextUpResourceFromList: () => ({
		resource: { fields: { slug: 'next-resource' } },
	}),
}))

vi.mock('./list-provider', () => ({
	useList: () => ({ list: { id: 'list-with-a-next-resource' } }),
}))

import { PostNextLessonButton } from './post-next-lesson-button'

describe('PostNextLessonButton', () => {
	it('keeps lesson terminology as the default', () => {
		const markup = renderToStaticMarkup(
			<PostNextLessonButton postId="current-resource" />,
		)

		expect(markup).toContain('Next lesson')
		expect(markup).not.toContain('Next page')
	})

	it('uses page terminology when rendered for a skill post', () => {
		const markup = renderToStaticMarkup(
			<PostNextLessonButton
				postId="current-skill"
				label="Next page"
			/>,
		)

		expect(markup).toContain('Next page')
		expect(markup).not.toContain('Next lesson')
	})
})
