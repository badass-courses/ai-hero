import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/app/(content)/skills/_components/skills-newsletter-cta', () => ({
	SkillsCourseCta: ({
		headline,
		source,
	}: {
		headline: string
		source: string
	}) =>
		React.createElement(
			'aside',
			{ 'data-course-source': source },
			headline,
		),
}))

import { resolvePostCta } from '@/lib/post-cta'

import { PostBodyCtaPlacement } from './post-body-cta-placement'

describe('PostBodyCtaPlacement', () => {
	it.each([
		'skills-grill-me',
		'grill-with-docs',
		'skills-handoff',
		'skills-wayfinder',
	])('puts a declared course CTA after the body on %s', (slug) => {
		const resolvedCta = resolvePostCta({
			postType: 'skill',
			cta: undefined,
		})
		const markup = renderToStaticMarkup(
			<PostBodyCtaPlacement
				resolvedCta={resolvedCta}
				slug={slug}
			>
				<p>Post body ends here.</p>
			</PostBodyCtaPlacement>,
		)

		expect(markup.indexOf('Post body ends here.')).toBeLessThan(
			markup.indexOf('data-course-source'),
		)
		expect(markup).toContain(
			`data-course-source="skill_page_course:${slug}"`,
		)
	})

	it('renders no CTA for an explicit none field', () => {
		const markup = renderToStaticMarkup(
			<PostBodyCtaPlacement
				resolvedCta={resolvePostCta({
					postType: 'skill',
					cta: 'none',
				})}
				slug="paid-page"
			>
				<p>Paid ask</p>
			</PostBodyCtaPlacement>,
		)

		expect(markup).toBe('<p>Paid ask</p>')
	})
})
