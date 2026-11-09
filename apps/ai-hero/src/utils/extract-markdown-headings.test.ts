import { describe, expect, it } from 'vitest'

import {
	createHeadingSlugger,
	extractMarkdownHeadings,
	flattenMarkdownHeadings,
} from './extract-markdown-headings'

describe('heading slug de-duplication', () => {
	it('uses the same stable suffixes in rendered headings and the extracted TOC', () => {
		const slug = createHeadingSlugger()
		const rendered = [slug('Same question'), slug('Same question'), slug('Same question')]
		const toc = flattenMarkdownHeadings(
			extractMarkdownHeadings(
				'## Same question\n\n## Same question\n\n## Same question',
			),
		)

		expect(rendered).toEqual([
			'same-question',
			'same-question-1',
			'same-question-2',
		])
		expect(toc).toEqual(rendered)
	})
})
