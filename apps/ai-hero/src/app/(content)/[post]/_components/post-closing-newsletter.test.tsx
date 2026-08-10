import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	gate: { subscriber: null as any, isResolved: false },
	session: { data: null as any, status: 'loading' },
}))

vi.mock('@/app/(content)/_components/post-related-newsletter', () => ({
	PostNewsletterCell: ({ knownIdentity }: { knownIdentity: boolean }) => (
		<div data-known={String(knownIdentity)}>newsletter</div>
	),
	PostNewsletterCellSkeleton: () => <div>newsletter skeleton</div>,
}))

vi.mock('@/hooks/use-cta-gate', () => ({
	useCtaGate: () => mocks.gate,
}))

vi.mock('next-auth/react', () => ({
	useSession: () => mocks.session,
}))

import { PostClosingNewsletter } from './post-closing-newsletter'

const render = () =>
	renderToStaticMarkup(<PostClosingNewsletter postSlug="static-post" />)

describe('PostClosingNewsletter', () => {
	beforeEach(() => {
		mocks.gate = { subscriber: null, isResolved: false }
		mocks.session = { data: null, status: 'loading' }
	})

	it('holds the cell shape while reader gates resolve', () => {
		expect(render()).toContain('newsletter skeleton')
	})

	it('hides the ask from an active subscriber', () => {
		mocks.gate = {
			subscriber: { state: 'active', fields: {} },
			isResolved: true,
		}
		mocks.session = { data: null, status: 'unauthenticated' }

		expect(render()).toBe('')
	})

	it('keeps one-click signup for a known reader', () => {
		mocks.gate = {
			subscriber: { state: 'inactive', fields: {}, hasIdentity: true },
			isResolved: true,
		}
		mocks.session = { data: null, status: 'unauthenticated' }

		expect(render()).toContain('data-known="true"')
	})
})
