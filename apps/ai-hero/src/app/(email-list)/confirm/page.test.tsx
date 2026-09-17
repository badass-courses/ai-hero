import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/app/(email-list)/_components/email', () => ({
	Email: () => <>learner@example.com</>,
}))

vi.mock('@/app/(email-list)/_components/signature', () => ({
	Signature: () => <>Matt</>,
}))

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import ConfirmSubscriptionPage from './page'

describe('/confirm course flow copy', () => {
	it('explains where lessons live and how progression works', async () => {
		const page = await ConfirmSubscriptionPage({
			searchParams: Promise.resolve({ flow: 'course' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('You’re in')
		expect(markup).toContain(
			'This is a seven-lesson email course. The lesson is the email itself. It will not appear under Courses in your AI Hero account.',
		)
		expect(markup).toContain(
			'Answer the question at the end if you want the next lesson in a few minutes. Otherwise, the next lesson arrives automatically after at least 18 hours.',
		)
	})

	it('preserves the standard confirmation flow', async () => {
		const page = await ConfirmSubscriptionPage({
			searchParams: Promise.resolve({}),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('Confirm your email address')
		expect(markup).toContain('with a confirmation link')
		expect(markup).not.toContain('seven-lesson email course')
	})
})
