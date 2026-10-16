import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	canCreate: false,
	canViewWorkshop: false,
	status: 'pending',
	fetchStatus: 'fetching',
	data: undefined as unknown,
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
	type WorkshopAccessInput,
	type WorkshopAccessView,
} from './workshop-access-boundary'
import { WorkshopDraftBanner } from './workshop-draft-banner'

const boundary = () =>
	renderToStaticMarkup(
		<WorkshopAccessBoundary
			anonymous={<div>buy branch</div>}
			anonymousWithoutCta={<div>sales no cta</div>}
			member={<div>member content</div>}
		/>,
	)

const legacyView = (status: string, canViewWorkshop: boolean) =>
	status === 'success' && canViewWorkshop ? 'member' : 'anonymous'

type Row = [
	sessionStatus: WorkshopAccessInput['sessionStatus'],
	status: WorkshopAccessInput['status'],
	fetchStatus: WorkshopAccessInput['fetchStatus'],
	hasData: boolean,
	canViewWorkshop: boolean,
	expected: WorkshopAccessView,
]

// sessionStatus, status, fetchStatus, hasData, canViewWorkshop -> view
const ROWS: Row[] = [
	['unauthenticated', 'success', 'idle', false, false, 'anonymous'],
	['unauthenticated', 'pending', 'idle', false, false, 'anonymous'],
	['loading', 'pending', 'idle', false, false, 'pending'],
	['loading', 'success', 'idle', true, true, 'pending'],
	['authenticated', 'pending', 'fetching', false, false, 'pending'],
	['authenticated', 'pending', 'paused', false, false, 'pending'],
	['authenticated', 'pending', 'idle', false, false, 'anonymous'],
	['authenticated', 'error', 'idle', false, false, 'error'],
	['authenticated', 'error', 'fetching', false, false, 'error'],
	['authenticated', 'error', 'idle', true, true, 'member'],
	['authenticated', 'error', 'idle', true, false, 'anonymous'],
	['authenticated', 'success', 'idle', true, true, 'member'],
	['authenticated', 'success', 'idle', true, false, 'anonymous'],
	['authenticated', 'success', 'fetching', true, true, 'member'],
]

describe('workshopAccessView', () => {
	it.each(ROWS)(
		'session=%s status=%s fetch=%s hasData=%s canView=%s -> %s',
		(sessionStatus, status, fetchStatus, hasData, canViewWorkshop, expected) => {
			expect(
				workshopAccessView({
					sessionStatus,
					status,
					fetchStatus,
					hasData,
					canViewWorkshop,
				}),
			).toBe(expected)
		},
	)

	it('differs from the legacy expression on signed-in pending and error rows', () => {
		// every signed-in pending/error row must be a row the legacy code got wrong
		for (const [sessionStatus, status, , , canView, expected] of ROWS) {
			if (
				sessionStatus === 'authenticated' &&
				(expected === 'pending' || expected === 'error')
			) {
				expect(legacyView(status, canView)).toBe('anonymous')
				expect(expected).not.toBe(legacyView(status, canView))
			}
		}
	})
})

describe('WorkshopAccessBoundary', () => {
	beforeEach(() => {
		mocks.canCreate = false
		mocks.canViewWorkshop = false
		mocks.status = 'pending'
		mocks.fetchStatus = 'fetching'
		mocks.data = undefined
		mocks.search = ''
		mocks.sessionStatus = 'unauthenticated'
	})

	it('shows the buy branch only to a confirmed signed-out viewer', () => {
		mocks.status = 'success'
		const markup = boundary()
		expect(markup).toContain('buy branch')
		expect(markup).not.toContain('member content')
	})

	it.each(['pending', 'error', 'success'] as const)(
		'never shows the buy branch while the session is loading (ability %s)',
		(status) => {
			mocks.sessionStatus = 'loading'
			mocks.status = status
			mocks.fetchStatus = 'idle'
			mocks.canViewWorkshop = status === 'success'
			const markup = boundary()
			expect(markup).toContain('sales no cta')
			expect(markup).not.toContain('buy branch')
			expect(markup).not.toContain('member content')
		},
	)

	it('holds the sales content without a buy ask while a signed-in check loads', () => {
		mocks.sessionStatus = 'authenticated'
		const markup = boundary()
		expect(markup).toContain('sales no cta')
		expect(markup).not.toContain('buy branch')
		expect(markup).not.toContain('member content')
	})

	it('shows a refresh note, not the buy branch, when a signed-in check fails', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'error'
		const markup = boundary()
		expect(markup).toContain('Refresh to try again')
		expect(markup).toContain('sales no cta')
		expect(markup).not.toContain('buy branch')
		expect(markup).not.toContain('member content')
	})

	it('keeps a member a member when a refetch errors', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'error'
		mocks.data = [{}]
		mocks.canViewWorkshop = true
		expect(boundary()).toContain('member content')
	})

	it('treats a disabled check as no check, so anonymous as before', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'pending'
		mocks.fetchStatus = 'idle'
		expect(boundary()).toContain('buy branch')
	})

	it('switches to the member branch after an entitled ability resolves', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'success'
		mocks.data = [{}]
		mocks.canViewWorkshop = true
		const markup = boundary()
		expect(markup).toContain('member content')
		expect(markup).not.toContain('buy branch')
	})

	it('forces the buy branch only for allowPurchase=true', () => {
		mocks.search = 'allowPurchase=true'

		const markup = renderToStaticMarkup(
			<WorkshopSidebarAccessBoundary
				anonymous={<div>waitlist</div>}
				anonymousWithoutCta={<div>sales no cta</div>}
				member={<div>member content</div>}
				forcedPurchase={<div>buy widget</div>}
			/>,
		)

		expect(markup).toContain('buy widget')
		expect(markup).not.toContain('waitlist')
	})
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
