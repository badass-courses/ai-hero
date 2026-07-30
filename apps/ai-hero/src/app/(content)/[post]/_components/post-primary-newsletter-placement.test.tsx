import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/primary-newsletter-cta', () => ({
	PrimaryNewsletterCta: () =>
		React.createElement('aside', { 'data-primary-newsletter': true }),
}))

import { resolvePostCta } from '@/lib/post-cta'

import { PostPrimaryNewsletterPlacement } from './post-primary-newsletter-placement'

describe('PostPrimaryNewsletterPlacement', () => {
	it('stands down when the course CTA resolves', () => {
		const markup = renderToStaticMarkup(
			<PostPrimaryNewsletterPlacement
				postSlug="skills-grill-me"
				resolvedCta={resolvePostCta({
					postType: 'skill',
					cta: undefined,
				})}
			/>,
		)

		expect(markup).toBe('')
	})

	it('renders when no course CTA resolves', () => {
		const markup = renderToStaticMarkup(
			<PostPrimaryNewsletterPlacement
				postSlug="plain-article"
				resolvedCta={resolvePostCta({
					postType: 'article',
					cta: undefined,
				})}
			/>,
		)

		expect(markup).toContain('data-primary-newsletter="true"')
	})
})
