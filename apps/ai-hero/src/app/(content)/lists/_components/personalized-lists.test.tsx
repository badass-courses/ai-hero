import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	query: {
		data: [] as Array<{ action: string; subject: string }>,
		status: 'pending',
	},
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getCurrentAbilityRules: {
				useQuery: () => mocks.query,
			},
		},
	},
}))

vi.mock('./lists-table', () => ({
	ListsTable: ({ canCreateContent }: { canCreateContent: boolean }) => (
		<div>{canCreateContent ? 'admin table' : 'reader table'}</div>
	),
}))

vi.mock('./create-list-form', () => ({
	CreateListForm: () => <div>create list</div>,
}))

import { PersonalizedLists } from './personalized-lists'

const render = () => renderToStaticMarkup(<PersonalizedLists lists={[]} />)

describe('PersonalizedLists', () => {
	beforeEach(() => {
		mocks.query = { data: [], status: 'pending' }
	})

	it('renders the public table before permissions resolve', () => {
		expect(render()).toContain('reader table')
		expect(render()).not.toContain('create list')
	})

	it('keeps editor controls hidden from ordinary readers', () => {
		mocks.query = { data: [], status: 'success' }

		expect(render()).toContain('reader table')
		expect(render()).not.toContain('create list')
	})

	it('restores editor controls after hydration', () => {
		mocks.query = {
			data: [{ action: 'manage', subject: 'all' }],
			status: 'success',
		}

		expect(render()).toContain('admin table')
		expect(render()).toContain('create list')
	})
})
