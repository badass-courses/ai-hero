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

import { PostActionBar } from './post-action-bar'

function render() {
	return renderToStaticMarkup(
		<PostActionBar postId="post-123" postSlug="static-post" />,
	)
}

describe('PostActionBar', () => {
	beforeEach(() => {
		mocks.query = { data: [], status: 'pending' }
	})

	it('renders nothing while client permissions load', () => {
		expect(render()).toBe('')
	})

	it('renders nothing without permission to update content', () => {
		mocks.query = { data: [], status: 'success' }

		expect(render()).toBe('')
	})

	it('links admins to the post editor after permissions load', () => {
		mocks.query = {
			data: [{ action: 'manage', subject: 'all' }],
			status: 'success',
		}

		expect(render()).toContain('href="/posts/static-post/edit"')
		expect(render()).toContain('Edit')
	})
})
