import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ResourceListView, type NextModuleLink } from './resource-list-view'

function render(
	overrides: Partial<React.ComponentProps<typeof ResourceListView>> = {},
) {
	return renderToStaticMarkup(
		<ResourceListView
			title="Getting To Know Claude Code"
			titleHref="/workshops/claude-code~p9j8f"
			moduleId="workshop-p9j8f"
			buildLessonHref={(slug) => `/workshops/claude-code~p9j8f/${slug}`}
			// The autoplay toggle needs a MuxPlayerProvider and has nothing to do
			// with these assertions.
			showAutoplay={false}
			{...overrides}
		/>,
	)
}

const availableNext: NextModuleLink = {
	title: 'Day 1 Fundamentals',
	href: '/workshops/fundamentals~bfkce/llm-constraints~z2y87',
}

describe('ResourceListView position and next-module affordances', () => {
	it('places the module in its parent', () => {
		expect(render({ positionLabel: 'Workshop 2 of 8' })).toContain(
			'Workshop 2 of 8',
		)
	})

	it('omits the position line when there is no parent to count against', () => {
		expect(render()).not.toContain('Workshop 2 of 8')
	})

	it('pins the next module as a link into its first lesson', () => {
		const markup = render({ nextModule: availableNext })

		expect(markup).toContain('Next workshop')
		expect(markup).toContain('Day 1 Fundamentals')
		expect(markup).toContain(
			'href="/workshops/fundamentals~bfkce/llm-constraints~z2y87"',
		)
	})

	it('shows an unreleased next module without making it clickable', () => {
		const markup = render({
			nextModule: {
				...availableNext,
				href: '/workshops/fundamentals~bfkce',
				locked: true,
				unlocksAt: 'June 1, 2026',
			},
		})

		expect(markup).toContain('Day 1 Fundamentals')
		expect(markup).toContain('Unlocks June 1, 2026')
		expect(markup).not.toContain('href="/workshops/fundamentals~bfkce"')
	})

	it('falls back to a plain unreleased note when there is no date', () => {
		const markup = render({
			nextModule: { ...availableNext, locked: true, unlocksAt: null },
		})

		expect(markup).toContain('Not released yet')
	})

	it('renders nothing extra for the last module in a parent', () => {
		expect(render()).not.toContain('Next workshop')
	})

	it('sits after the lessons, in the list rather than pinned below it', () => {
		const markup = render({
			nextModule: availableNext,
			resources: [
				{
					resource: {
						id: 'lesson-pwt8r',
						type: 'lesson',
						fields: { slug: 'permissions~pwt8r', title: 'Permissions' },
					},
				},
			] as any,
		})

		expect(markup.indexOf('Next workshop')).toBeGreaterThan(
			markup.indexOf('Permissions'),
		)
		// Inside the scroller, so it scrolls with the lessons above it.
		const scrollerEnd = markup.lastIndexOf('data-slot="scroll-area-viewport"')
		expect(markup.indexOf('Next workshop')).toBeGreaterThan(scrollerEnd)
	})
})
