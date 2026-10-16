import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { TransferScreen, type TransferView } from './transfer-screen'

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }))

function render(view: TransferView) {
	return renderToStaticMarkup(
		<TransferScreen
			view={view}
			transferId="put_1"
			productName="Synthetic Course"
			senderName="Pat Buyer"
			senderEmail="pat@work.example"
			recipientEmail="pat@home.example"
			accept={async () => {}}
		/>,
	)
}

describe('transfer screen', () => {
	it('lets the signed-in recipient accept, and says what accepting does', () => {
		const html = render({ kind: 'accept' })
		expect(html).toContain('Sent to you by Pat Buyer')
		expect(html).toContain('Synthetic Course')
		expect(html).toContain('Accept your seat')
		expect(html).toContain('Accept transfer')
		expect(html).toContain('pat@home.example')
		expect(html).toContain('href="/privacy"')
		expect(html).not.toContain('Email me a login link')
	})

	it('offers anyone else a login link for the recipient, back to this page', () => {
		const signedOut = render({ kind: 'sign-in', viewerEmail: null })
		expect(signedOut).toContain('Sign in as p**@home.example to accept')
		expect(signedOut).not.toContain('pat@home.example')
		expect(signedOut).toContain('Email me a login link')
		expect(signedOut).toContain('brings you back here to accept')
		expect(signedOut).not.toContain('Accept transfer')

		const otherAccount = render({
			kind: 'sign-in',
			viewerEmail: 'pat@work.example',
		})
		expect(otherAccount).toContain('signed in as')
		expect(otherAccount).toContain('pat@work.example')
	})

	it('sends the recipient on to the course once it is theirs', () => {
		const html = render({
			kind: 'accepted',
			viewerIsRecipient: true,
			start: {
				href: '/workshops/synthetic-course',
				label: 'Start learning',
				startsLabel: null,
			},
		})
		expect(html).toContain('Transfer complete')
		expect(html).toContain('data-purchase-badge="ready"')
		expect(html).toContain('href="/workshops/synthetic-course"')
		expect(html).not.toContain('now belongs to')
	})

	it('tells anyone else who the seat belongs to now', () => {
		const html = render({ kind: 'accepted', viewerIsRecipient: false, start: null })
		expect(html).toContain('This seat now belongs to')
		expect(html).not.toContain('Start learning')
	})

	it.each([
		['canceled', 'Pat Buyer canceled this transfer'],
		['expired', 'This invitation expired before it was accepted'],
	] as const)('explains a %s transfer and points at the sender', (kind, copy) => {
		const html = render({ kind })
		expect(html).toContain(copy)
		expect(html).toContain('href="mailto:pat@work.example"')
		expect(html).not.toContain('Accept transfer')
	})
})
