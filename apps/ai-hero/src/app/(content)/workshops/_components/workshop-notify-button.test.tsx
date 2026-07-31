import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sessionStatus: 'unauthenticated' as
		| 'authenticated'
		| 'unauthenticated'
		| 'loading',
	subscriber: null as { id: number; fields: Record<string, string> } | null,
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/hooks/use-cta-gate', () => ({
	useCtaGate: () => ({ subscriber: mocks.subscriber, isResolved: true }),
}))

vi.mock('./workshop-interest-button', () => ({
	WorkshopInterestButton: ({ children }: { children: React.ReactNode }) => (
		<button type="button" data-workshop-interest-action="one-click">
			{children}
		</button>
	),
}))

import { WorkshopNotifyButton } from './workshop-notify-button'

describe('WorkshopNotifyButton identity variants', () => {
	beforeEach(() => {
		mocks.sessionStatus = 'unauthenticated'
		mocks.subscriber = null
	})

	it('performs the interest action directly for a signed-in reader', () => {
		mocks.sessionStatus = 'authenticated'

		const markup = renderToStaticMarkup(
			<WorkshopNotifyButton workshopSlug="agentic-workflows" />,
		)

		expect(markup).toContain('data-workshop-interest-action="one-click"')
		expect(markup).toContain('Get notified')
	})

	it('keeps the form-navigation button for an anonymous reader', () => {
		const markup = renderToStaticMarkup(
			<WorkshopNotifyButton workshopSlug="agentic-workflows" />,
		)

		expect(markup).not.toContain('data-workshop-interest-action="one-click"')
		expect(markup).toContain('Get notified')
	})
})
