import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getSkillsCourseCtaState: {
				useQuery: () => ({
					data: { state: 'fresh' },
					status: 'success',
				}),
			},
		},
	},
}))

vi.mock('@/app/(content)/skills/_components/skills-newsletter', () => ({
	Root: ({ children }: { children: React.ReactNode }) =>
		React.createElement('div', null, children),
	StatusView: ({ form }: { form: React.ReactNode }) =>
		React.createElement(React.Fragment, null, form),
	Form: () => React.createElement('form', null, 'course form'),
	Privacy: ({ formMessage }: { formMessage: React.ReactNode }) =>
		React.createElement('p', null, formMessage),
	RestartCourse: () => React.createElement('button', null, 'restart'),
	TagMeButton: () => React.createElement('button', null, 'start'),
}))

import { NewsletterSection } from '@/components/landing/newsletter-section'
import { SkillsCourseCta } from '@/components/landing/skills-course-cta'
import { SKILLS_COURSE_WAYFINDING } from '@/lib/skills-content'

const CONCISE_SUBTITLE =
	'Start with the free email course: seven lessons, tied to real work, with a repeatable agent workflow at the end.'

const landingSource = readFileSync(
	new URL('../../../content/landing.md', import.meta.url),
	'utf8',
)
const heroSource = readFileSync(
	new URL('../../components/landing/hero.tsx', import.meta.url),
	'utf8',
)
const courseCtaSubtitle = landingSource.match(
	/subTitle="([^"]+)"\s*>\s*<CourseCta\s*\/>/,
)?.[1]

describe('homepage course copy composition', () => {
	it('uses the shared free email-course label as the hero default', () => {
		expect(SKILLS_COURSE_WAYFINDING.heroCtaLabel).toBe(
			'Start the free email course',
		)
		expect(heroSource).toContain(
			'ctaLabel = SKILLS_COURSE_WAYFINDING.heroCtaLabel',
		)
		expect(heroSource).not.toMatch(/(?:7-day|seven-day) course/i)
	})

	it('keeps the concise subtitle and leaves mechanics out of the CMS field', () => {
		expect(courseCtaSubtitle).toBe(CONCISE_SUBTITLE)
		expect(courseCtaSubtitle).not.toContain(SKILLS_COURSE_WAYFINDING.signup)
		expect(courseCtaSubtitle).not.toContain(SKILLS_COURSE_WAYFINDING.progression)
	})

	it('renders the CMS subtitle once and detailed mechanics once in CourseCta', () => {
		if (!courseCtaSubtitle) throw new Error('CourseCta subtitle not found')

		const courseCta = React.createElement(
			SkillsCourseCta as React.ComponentType<{ status: 'show-form' }>,
			{ status: 'show-form' },
		)
		const markup = renderToStaticMarkup(
			React.createElement(
				NewsletterSection as React.ComponentType<{
					subTitle: React.ReactNode
					children?: React.ReactNode
				}>,
				{ subTitle: courseCtaSubtitle },
				courseCta,
			),
		)

		expect(markup.split(CONCISE_SUBTITLE)).toHaveLength(2)
		expect(markup.split(SKILLS_COURSE_WAYFINDING.signup)).toHaveLength(2)
		expect(markup.split(SKILLS_COURSE_WAYFINDING.progression)).toHaveLength(2)
	})
})
