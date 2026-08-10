import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	query: {
		data: undefined as
			| { allPosts: unknown[]; allLists: unknown[] }
			| null
			| undefined,
		status: 'pending',
	},
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getPostActionsData: {
				useQuery: () => mocks.query,
			},
		},
	},
}))

vi.mock('./post-actions', () => ({
	PostActions: () => <aside>post actions</aside>,
}))

import { PostListActions } from './post-list-actions'

const render = () => renderToStaticMarkup(<PostListActions />)

describe('PostListActions', () => {
	beforeEach(() => {
		mocks.query = { data: undefined, status: 'pending' }
	})

	it('renders nothing while the client-only admin query loads', () => {
		expect(render()).toBe('')
	})

	it('renders nothing when the server rejects editor access', () => {
		mocks.query = { data: null, status: 'success' }

		expect(render()).toBe('')
	})

	it('restores post actions for an authorized editor', () => {
		mocks.query = {
			data: { allPosts: [], allLists: [] },
			status: 'success',
		}

		expect(render()).toContain('post actions')
	})
})
