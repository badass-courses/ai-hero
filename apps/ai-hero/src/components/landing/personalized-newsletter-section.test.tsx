import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	query: {
		data: undefined as { state: string } | undefined,
		status: 'pending',
	},
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getSkillsCourseCtaState: {
				useQuery: () => mocks.query,
			},
		},
	},
}))

vi.mock('./newsletter-section', () => ({
	NewsletterSection: ({
		heading,
		children,
	}: {
		heading?: React.ReactNode
		children: React.ReactNode
	}) => (
		<section>
			{heading}
			{children}
		</section>
	),
}))

vi.mock('./slim-newsletter-form', () => ({
	SlimNewsletterForm: () => <div>course form</div>,
}))

import { PersonalizedNewsletterSection } from './personalized-newsletter-section'

const render = () =>
	renderToStaticMarkup(
		<PersonalizedNewsletterSection heading="Start here">
			<span>Course form</span>
		</PersonalizedNewsletterSection>,
	)

describe('PersonalizedNewsletterSection', () => {
	beforeEach(() => {
		mocks.query = { data: undefined, status: 'pending' }
	})

	it('renders nothing while reader state loads', () => {
		expect(render()).toBe('')
	})

	it('shows the static offer to a fresh reader after hydration', () => {
		mocks.query = { data: { state: 'fresh' }, status: 'success' }

		expect(render()).toContain('Start here')
		expect(render()).toContain('Course form')
	})

	it('hides the offer from a reader already taking the course', () => {
		mocks.query = { data: { state: 'subscribed' }, status: 'success' }

		expect(render()).toBe('')
	})
})
