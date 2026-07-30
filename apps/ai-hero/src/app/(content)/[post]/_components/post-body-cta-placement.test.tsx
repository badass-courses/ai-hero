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
		'skills-to-spec',
		'skills-tdd',
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

	it('keeps the mapped CTA on the Claude Code status-line article', () => {
		const markup = renderToStaticMarkup(
			<PostBodyCtaPlacement
				resolvedCta={resolvePostCta({
					postType: 'article',
					cta: undefined,
				})}
				slug="creating-the-perfect-claude-code-status-line"
			>
				<p>Post body</p>
			</PostBodyCtaPlacement>,
		)

		expect(markup).toContain('Get practical AI coding workflow notes')
	})

	it.each([
		'cohorts/claude-code-for-real-engineers-2026-04',
		'cohorts/ai-coding-for-real-engineers-m0k0w',
		'learn-anything-with-my-teach-skill',
	])('renders no declared CTA for paid page %s', (slug) => {
		const markup = renderToStaticMarkup(
			<PostBodyCtaPlacement
				resolvedCta={resolvePostCta({
					postType: 'skill',
					cta: 'none',
				})}
				slug={slug}
			>
				<p>Paid ask</p>
			</PostBodyCtaPlacement>,
		)

		expect(markup).toBe('<p>Paid ask</p>')
	})

	describe('precedence against the cohort CTA', () => {
		const cohortCta = <aside data-cohort-cta>Join the next cohort</aside>

		it('yields the slot to the course ask on a skill page', () => {
			const markup = renderToStaticMarkup(
				<PostBodyCtaPlacement
					resolvedCta={resolvePostCta({ postType: 'skill', cta: undefined })}
					slug="skills-grill-me"
					cohortCta={cohortCta}
				>
					<p>Post body</p>
				</PostBodyCtaPlacement>,
			)

			expect(markup).toContain('data-course-source')
			expect(markup).not.toContain('data-cohort-cta')
		})

		it('yields the slot to a mapped organic CTA', () => {
			const markup = renderToStaticMarkup(
				<PostBodyCtaPlacement
					resolvedCta={resolvePostCta({ postType: 'article', cta: undefined })}
					slug="creating-the-perfect-claude-code-status-line"
					cohortCta={cohortCta}
				>
					<p>Post body</p>
				</PostBodyCtaPlacement>,
			)

			expect(markup).toContain('Get practical AI coding workflow notes')
			expect(markup).not.toContain('data-cohort-cta')
		})

		it('takes the slot when nothing else claims it', () => {
			const markup = renderToStaticMarkup(
				<PostBodyCtaPlacement
					resolvedCta={resolvePostCta({ postType: 'article', cta: undefined })}
					slug="an-article-with-no-declared-cta"
					cohortCta={cohortCta}
				>
					<p>Post body</p>
				</PostBodyCtaPlacement>,
			)

			expect(markup).toContain('data-cohort-cta')
			expect(markup).not.toContain('data-course-source')
		})

		it('renders the body alone when there is no cohort to offer', () => {
			const markup = renderToStaticMarkup(
				<PostBodyCtaPlacement
					resolvedCta={resolvePostCta({ postType: 'article', cta: 'none' })}
					slug="an-article-with-no-declared-cta"
					cohortCta={null}
				>
					<p>Post body</p>
				</PostBodyCtaPlacement>,
			)

			expect(markup).toBe('<p>Post body</p>')
		})
	})
})
