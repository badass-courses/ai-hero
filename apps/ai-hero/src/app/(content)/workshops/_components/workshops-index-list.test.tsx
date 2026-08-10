import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sessionStatus: 'unauthenticated',
	abilityQuery: {
		data: [] as Array<{ action: string; subject: string }>,
		status: 'pending',
	},
	editorData: undefined as any,
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getCurrentAbilityRules: { useQuery: () => mocks.abilityQuery },
		},
		contentResources: {
			getAll: { useQuery: () => ({ data: mocks.editorData }) },
		},
	},
}))

vi.mock('@/components/contributor', () => ({
	Contributor: () => <span>Contributor</span>,
}))

import { WorkshopsIndexList } from './workshops-index-list'

const publicWorkshop = {
	id: 'workshop-public',
	type: 'workshop',
	fields: {
		slug: 'public-workshop',
		title: 'Public Workshop',
		description: 'Public description',
		state: 'published',
		visibility: 'public',
	},
} as any

const privateWorkshop = {
	...publicWorkshop,
	id: 'workshop-private',
	fields: {
		...publicWorkshop.fields,
		slug: 'private-workshop',
		title: 'Private Workshop',
		visibility: 'private',
	},
}

describe('WorkshopsIndexList', () => {
	beforeEach(() => {
		mocks.sessionStatus = 'unauthenticated'
		mocks.abilityQuery = { data: [], status: 'pending' }
		mocks.editorData = undefined
	})

	it('renders public rows without editor affordances for anonymous visitors', () => {
		const markup = renderToStaticMarkup(
			<WorkshopsIndexList initialWorkshops={[publicWorkshop]} />,
		)

		expect(markup).toContain('Public Workshop')
		expect(markup).not.toContain('Private Workshop')
		expect(markup).not.toContain('New Workshop')
		expect(markup).not.toContain('>Edit<')
	})

	it('hydrates private rows and edit controls for an editor', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.abilityQuery = {
			data: [{ action: 'manage', subject: 'all' }],
			status: 'success',
		}
		mocks.editorData = [privateWorkshop]

		const markup = renderToStaticMarkup(
			<WorkshopsIndexList initialWorkshops={[publicWorkshop]} />,
		)

		expect(markup).toContain('Private Workshop')
		expect(markup).toContain('New Workshop')
		expect(markup).toContain('>Edit<')
	})
})
