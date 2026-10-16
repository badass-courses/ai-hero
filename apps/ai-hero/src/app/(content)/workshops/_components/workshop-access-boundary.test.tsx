import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	canCreate: false,
	canViewWorkshop: false,
	status: 'pending',
	search: '',
	sessionStatus: 'unauthenticated',
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('next/navigation', () => ({
	useSearchParams: () => new URLSearchParams(mocks.search),
}))

vi.mock('./use-workshop-ability', () => ({
	useWorkshopAbility: () => mocks,
}))

import {
	WorkshopAccessBoundary,
	WorkshopSidebarAccessBoundary,
	workshopAccessView,
} from './workshop-access-boundary'
import { WorkshopDraftBanner } from './workshop-draft-banner'

describe('WorkshopAccessBoundary', () => {
	beforeEach(() => {
		mocks.canCreate = false
		mocks.canViewWorkshop = false
		mocks.status = 'pending'
		mocks.search = ''
		mocks.sessionStatus = 'unauthenticated'
	})

	it('renders only the anonymous-safe branch before ability hydration', () => {
		const markup = renderToStaticMarkup(
			<WorkshopAccessBoundary
				anonymous={<div>public shell</div>}
				member={<div>member content</div>}
			/>,
		)

		expect(markup).toContain('public shell')
		expect(markup).not.toContain('member content')
	})

	it('switches to the member branch after an entitled ability resolves', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'success'
		mocks.canViewWorkshop = true

		const markup = renderToStaticMarkup(
			<WorkshopAccessBoundary
				anonymous={<div>public shell</div>}
				member={<div>member content</div>}
			/>,
		)

		expect(markup).toContain('member content')
		expect(markup).not.toContain('public shell')
	})

	it('renders neither buy nor member content for a signed-in viewer while loading', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'pending'

		const markup = renderToStaticMarkup(
			<WorkshopAccessBoundary
				anonymous={<div>public shell</div>}
				member={<div>member content</div>}
			/>,
		)

		expect(markup).not.toContain('public shell')
		expect(markup).not.toContain('member content')
	})

	it('shows a refresh note, not the buy branch, when a signed-in ability check fails', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'error'

		const markup = renderToStaticMarkup(
			<WorkshopAccessBoundary
				anonymous={<div>public shell</div>}
				member={<div>member content</div>}
			/>,
		)

		expect(markup).toContain('Refresh to try again')
		expect(markup).not.toContain('public shell')
		expect(markup).not.toContain('member content')
	})

	it('forces the buy branch only for allowPurchase=true', () => {
		mocks.search = 'allowPurchase=true'

		const markup = renderToStaticMarkup(
			<WorkshopSidebarAccessBoundary
				anonymous={<div>waitlist</div>}
				member={<div>member content</div>}
				forcedPurchase={<div>buy widget</div>}
			/>,
		)

		expect(markup).toContain('buy widget')
		expect(markup).not.toContain('waitlist')
	})
})

describe('workshopAccessView', () => {
	const statuses = ['pending', 'error', 'success'] as const
	for (const signedIn of [false, true]) {
		for (const status of statuses) {
			for (const canViewWorkshop of [false, true]) {
				const expected = !signedIn
					? 'anonymous'
					: status === 'pending'
						? 'pending'
						: status === 'error'
							? 'error'
							: canViewWorkshop
								? 'member'
								: 'anonymous'
				it(`signedIn=${signedIn} status=${status} canView=${canViewWorkshop} -> ${expected}`, () => {
					expect(
						workshopAccessView({ signedIn, status, canViewWorkshop }),
					).toBe(expected)
				})
			}
		}
	}
})

describe('WorkshopDraftBanner', () => {
	it('keeps editor state out of anonymous HTML', () => {
		expect(
			renderToStaticMarkup(
				<WorkshopDraftBanner state="draft" type="workshop" />,
			),
		).toBe('')
	})

	it('shows the draft state after editor ability hydration', () => {
		mocks.status = 'success'
		mocks.canCreate = true

		const markup = renderToStaticMarkup(
			<WorkshopDraftBanner state="draft" type="workshop" />,
		)

		expect(markup).toContain('draft workshop')
	})
})
