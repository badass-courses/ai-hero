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

const boundary = (showErrorNote = true) =>
	renderToStaticMarkup(
		<WorkshopAccessBoundary
			anonymous={<div>buy branch</div>}
			anonymousWithoutCta={<div>sales no cta</div>}
			member={<div>member content</div>}
			showErrorNote={showErrorNote}
		/>,
	)

const legacyView = (status: string, canViewWorkshop: boolean) =>
	status === 'success' && canViewWorkshop ? 'member' : 'anonymous'

const EXPECTED: Record<string, WorkshopAccessView> = {
	'unauthenticated|pending|fetching|false|false': 'anonymous',
	'unauthenticated|pending|fetching|false|true': 'anonymous',
	'unauthenticated|pending|fetching|true|false': 'anonymous',
	'unauthenticated|pending|fetching|true|true': 'anonymous',
	'unauthenticated|pending|paused|false|false': 'anonymous',
	'unauthenticated|pending|paused|false|true': 'anonymous',
	'unauthenticated|pending|paused|true|false': 'anonymous',
	'unauthenticated|pending|paused|true|true': 'anonymous',
	'unauthenticated|pending|idle|false|false': 'anonymous',
	'unauthenticated|pending|idle|false|true': 'anonymous',
	'unauthenticated|pending|idle|true|false': 'anonymous',
	'unauthenticated|pending|idle|true|true': 'anonymous',
	'unauthenticated|error|fetching|false|false': 'anonymous',
	'unauthenticated|error|fetching|false|true': 'anonymous',
	'unauthenticated|error|fetching|true|false': 'anonymous',
	'unauthenticated|error|fetching|true|true': 'anonymous',
	'unauthenticated|error|paused|false|false': 'anonymous',
	'unauthenticated|error|paused|false|true': 'anonymous',
	'unauthenticated|error|paused|true|false': 'anonymous',
	'unauthenticated|error|paused|true|true': 'anonymous',
	'unauthenticated|error|idle|false|false': 'anonymous',
	'unauthenticated|error|idle|false|true': 'anonymous',
	'unauthenticated|error|idle|true|false': 'anonymous',
	'unauthenticated|error|idle|true|true': 'anonymous',
	'unauthenticated|success|fetching|false|false': 'anonymous',
	'unauthenticated|success|fetching|false|true': 'anonymous',
	'unauthenticated|success|fetching|true|false': 'anonymous',
	'unauthenticated|success|fetching|true|true': 'anonymous',
	'unauthenticated|success|paused|false|false': 'anonymous',
	'unauthenticated|success|paused|false|true': 'anonymous',
	'unauthenticated|success|paused|true|false': 'anonymous',
	'unauthenticated|success|paused|true|true': 'anonymous',
	'unauthenticated|success|idle|false|false': 'anonymous',
	'unauthenticated|success|idle|false|true': 'anonymous',
	'unauthenticated|success|idle|true|false': 'anonymous',
	'unauthenticated|success|idle|true|true': 'anonymous',
	'loading|pending|fetching|false|false': 'pending',
	'loading|pending|fetching|false|true': 'pending',
	'loading|pending|fetching|true|false': 'pending',
	'loading|pending|fetching|true|true': 'pending',
	'loading|pending|paused|false|false': 'pending',
	'loading|pending|paused|false|true': 'pending',
	'loading|pending|paused|true|false': 'pending',
	'loading|pending|paused|true|true': 'pending',
	'loading|pending|idle|false|false': 'pending',
	'loading|pending|idle|false|true': 'pending',
	'loading|pending|idle|true|false': 'pending',
	'loading|pending|idle|true|true': 'pending',
	'loading|error|fetching|false|false': 'pending',
	'loading|error|fetching|false|true': 'pending',
	'loading|error|fetching|true|false': 'pending',
	'loading|error|fetching|true|true': 'pending',
	'loading|error|paused|false|false': 'pending',
	'loading|error|paused|false|true': 'pending',
	'loading|error|paused|true|false': 'pending',
	'loading|error|paused|true|true': 'pending',
	'loading|error|idle|false|false': 'pending',
	'loading|error|idle|false|true': 'pending',
	'loading|error|idle|true|false': 'pending',
	'loading|error|idle|true|true': 'pending',
	'loading|success|fetching|false|false': 'pending',
	'loading|success|fetching|false|true': 'pending',
	'loading|success|fetching|true|false': 'pending',
	'loading|success|fetching|true|true': 'pending',
	'loading|success|paused|false|false': 'pending',
	'loading|success|paused|false|true': 'pending',
	'loading|success|paused|true|false': 'pending',
	'loading|success|paused|true|true': 'pending',
	'loading|success|idle|false|false': 'pending',
	'loading|success|idle|false|true': 'pending',
	'loading|success|idle|true|false': 'pending',
	'loading|success|idle|true|true': 'pending',
	'authenticated|pending|fetching|false|false': 'pending',
	'authenticated|pending|fetching|false|true': 'pending',
	'authenticated|pending|fetching|true|false': 'pending',
	'authenticated|pending|fetching|true|true': 'pending',
	'authenticated|pending|paused|false|false': 'pending',
	'authenticated|pending|paused|false|true': 'pending',
	'authenticated|pending|paused|true|false': 'pending',
	'authenticated|pending|paused|true|true': 'pending',
	'authenticated|pending|idle|false|false': 'anonymous',
	'authenticated|pending|idle|false|true': 'anonymous',
	'authenticated|pending|idle|true|false': 'anonymous',
	'authenticated|pending|idle|true|true': 'anonymous',
	'authenticated|error|fetching|false|false': 'error',
	'authenticated|error|fetching|false|true': 'anonymous',
	'authenticated|error|fetching|true|false': 'error',
	'authenticated|error|fetching|true|true': 'member',
	'authenticated|error|paused|false|false': 'error',
	'authenticated|error|paused|false|true': 'anonymous',
	'authenticated|error|paused|true|false': 'error',
	'authenticated|error|paused|true|true': 'member',
	'authenticated|error|idle|false|false': 'error',
	'authenticated|error|idle|false|true': 'anonymous',
	'authenticated|error|idle|true|false': 'error',
	'authenticated|error|idle|true|true': 'member',
	'authenticated|success|fetching|false|false': 'anonymous',
	'authenticated|success|fetching|false|true': 'anonymous',
	'authenticated|success|fetching|true|false': 'member',
	'authenticated|success|fetching|true|true': 'member',
	'authenticated|success|paused|false|false': 'anonymous',
	'authenticated|success|paused|false|true': 'anonymous',
	'authenticated|success|paused|true|false': 'member',
	'authenticated|success|paused|true|true': 'member',
	'authenticated|success|idle|false|false': 'anonymous',
	'authenticated|success|idle|false|true': 'anonymous',
	'authenticated|success|idle|true|false': 'member',
	'authenticated|success|idle|true|true': 'member',
}

// session | status | fetchStatus | canView | hasData -> view
const COMBOS = Object.keys(EXPECTED).map((key) => {
	const [sessionStatus, status, fetchStatus, canView, hasData] = key.split('|')
	return {
		key,
		input: {
			sessionStatus,
			status,
			fetchStatus,
			canViewWorkshop: canView === 'true',
			hasData: hasData === 'true',
		} as WorkshopAccessInput,
	}
})

describe('workshopAccessView', () => {
	it('covers the full cross product', () => {
		expect(COMBOS).toHaveLength(3 * 3 * 3 * 2 * 2)
	})

	it.each(COMBOS)('$key', ({ key, input }) => {
		expect(workshopAccessView(input)).toBe(EXPECTED[key])
	})

	it('differs from the legacy expression on every pending and error row, loading session included', () => {
		const rows = COMBOS.filter(
			({ key }) => EXPECTED[key] === 'pending' || EXPECTED[key] === 'error',
		)
		expect(
			rows.some(({ input }) => input.sessionStatus === 'loading'),
		).toBe(true)
		expect(
			rows.some(({ input }) => input.sessionStatus === 'authenticated'),
		).toBe(true)
		for (const { key, input } of rows) {
			expect(EXPECTED[key]).not.toBe(
				legacyView(input.status, input.canViewWorkshop),
			)
		}
	})

	it('shows the buy branch to a signed-out viewer whatever the query says', () => {
		for (const { key, input } of COMBOS) {
			if (input.sessionStatus === 'unauthenticated') {
				expect(EXPECTED[key]).toBe('anonymous')
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

	it('renders no note at an inline mount, only the sales content', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.status = 'error'
		const markup = boundary(false)
		expect(markup).not.toContain('Refresh to try again')
		expect(markup).not.toContain('buy branch')
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
