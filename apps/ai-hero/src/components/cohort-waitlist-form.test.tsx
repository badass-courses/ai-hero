import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sessionStatus: 'unauthenticated' as
		| 'authenticated'
		| 'unauthenticated'
		| 'loading',
}))

vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/components/cta/conversion-intent-button', () => ({
	ConversionIntentButton: ({
		label,
		className,
	}: {
		label: string
		className?: string
	}) => (
		<button
			type="button"
			data-conversion-mode="one-click"
			className={className}
		>
			{label}
		</button>
	),
}))

vi.mock('@/components/cta/conversion-intent-form', () => ({
	ConversionIntentForm: () => (
		<form data-conversion-mode="form">
			<input name="email" />
		</form>
	),
}))

import { WaitlistForm } from './cohort-waitlist-form'

describe('WaitlistForm identity variants', () => {
	beforeEach(() => {
		mocks.sessionStatus = 'unauthenticated'
	})

	it('renders one button and no email field for a signed-in reader', () => {
		mocks.sessionStatus = 'authenticated'

		const markup = renderToStaticMarkup(
			<WaitlistForm
				actionLabel="Join the waitlist"
				productName="Cohort Four"
				surface="homepage-cohort"
			/>,
		)

		expect(markup).toContain('data-conversion-mode="one-click"')
		expect(markup).not.toContain('<input')
		expect(markup).toContain('w-fit')
		expect(markup).not.toContain('@[520px]:w-auto')
	})

	it('renders the email form for an anonymous reader', () => {
		const markup = renderToStaticMarkup(
			<WaitlistForm
				actionLabel="Join the waitlist"
				productName="Cohort Four"
				surface="courses-cohort"
			/>,
		)

		expect(markup).toContain('data-conversion-mode="form"')
		expect(markup).toContain('<input')
	})
})
