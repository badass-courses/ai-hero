import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	canCreate: false,
	canViewWorkshop: false,
	status: 'pending',
}))

vi.mock('./use-workshop-ability', () => ({
	useWorkshopAbility: () => mocks,
}))

import { WorkshopAccessBoundary } from './workshop-access-boundary'
import { WorkshopDraftBanner } from './workshop-draft-banner'

describe('WorkshopAccessBoundary', () => {
	beforeEach(() => {
		mocks.canCreate = false
		mocks.canViewWorkshop = false
		mocks.status = 'pending'
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
