import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@coursebuilder/ui/feedback-widget', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('@coursebuilder/ui/feedback-widget')
	>()),
	useFeedback: () => ({ setIsFeedbackDialogOpen: vi.fn() }),
}))

vi.mock('./use-feedback-form', () => ({
	useFeedbackForm: () => ({
		initialValues: {
			text: 'my typed draft',
			context: {
				category: 'general',
				emotion: ':wave:',
				url: 'https://example.com',
				location: 'navigation',
			},
		},
		submitFeedbackForm: vi.fn(),
		isSubmitted: false,
		error: "We couldn't send that. Please email team@aihero.dev.",
	}),
}))

import { FeedbackForm } from './feedback-dialog'

describe('FeedbackForm failure', () => {
	it('shows the plain message and keeps the form with the typed draft', () => {
		const markup = renderToStaticMarkup(<FeedbackForm location="navigation" />)
		expect(markup).toContain(
			'We couldn&#x27;t send that. Please email team@aihero.dev.',
		)
		expect(markup).toContain('my typed draft')
		expect(markup).toContain('id="feedback-text"')
	})
})
