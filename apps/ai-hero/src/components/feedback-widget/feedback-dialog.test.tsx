import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@coursebuilder/ui/feedback-widget', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('@coursebuilder/ui/feedback-widget')
		>()

	return {
		...actual,
		useFeedback: () => ({ setIsFeedbackDialogOpen: vi.fn() }),
	}
})

vi.mock('./use-feedback-form', () => ({
	useFeedbackForm: () => ({
		initialValues: {
			text: '',
			context: {
				category: 'general',
				emotion: ':wave:',
				url: 'https://example.com',
				location: 'navigation',
			},
		},
		submitFeedbackForm: vi.fn(),
		isSubmitted: false,
		error: undefined,
	}),
}))

import { FeedbackForm } from './feedback-dialog'

describe('FeedbackForm mobile controls', () => {
	it('uses phone-safe text sizing and fluid touch targets', () => {
		const markup = renderToStaticMarkup(<FeedbackForm location="navigation" />)

		expect(markup).toContain('id="feedback-text"')
		expect(markup).toContain('text-base sm:min-h-36 sm:text-sm')
		expect(markup).toContain('grid grid-cols-3 gap-2')
		expect(markup).toContain('min-h-11')
		expect(markup).toContain('What should we know?')
	})
})
