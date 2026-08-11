import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChangelogPage, parseChangelogPage } from './paginated-changelog'

describe('parseChangelogPage', () => {
	it.each([null, '', '0', '-1', '1.5', 'Infinity', 'wat']) (
		'falls back to page one for %s',
		(value) => {
			expect(parseChangelogPage(value)).toBe(1)
		},
	)

	it('accepts a positive integer page', () => {
		expect(parseChangelogPage('2')).toBe(2)
	})
})

describe('ChangelogPage', () => {
	it('slices cached changelog items without a server query', () => {
		const items = Array.from({ length: 12 }, (_, index) => ({
			id: String(index + 1),
			href: `/skills/${index + 1}`,
			title: `Entry ${index + 1}`,
			publishedAt: null,
		}))

		const markup = renderToStaticMarkup(
			<ChangelogPage items={items} currentPage={2} pageSize={10} />,
		)

		expect(markup).toContain('Entry 11')
		expect(markup).toContain('Entry 12')
		expect(markup).not.toContain('Entry 10')
	})
})
