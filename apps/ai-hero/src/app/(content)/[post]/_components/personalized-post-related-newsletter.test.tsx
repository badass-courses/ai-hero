import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sessionStatus: 'unauthenticated',
	personalizedItems: undefined as
		| Array<{ id: string; title: string; slug: string; meta: string }>
		| undefined,
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		typesense: {
			getRelatedPostItems: {
				useQuery: () => ({ data: mocks.personalizedItems }),
			},
		},
	},
}))

vi.mock('@/app/(content)/_components/post-related-newsletter', () => ({
	PostRelatedNewsletter: ({ items }: { items: Array<{ title: string }> }) => (
		<div>{items.map((item) => item.title).join(',')}</div>
	),
}))

import { PersonalizedPostRelatedNewsletter } from './personalized-post-related-newsletter'

const publicItems = [
	{ id: 'public', title: 'Public result', slug: 'public', meta: 'Article' },
]

describe('PersonalizedPostRelatedNewsletter', () => {
	beforeEach(() => {
		mocks.sessionStatus = 'unauthenticated'
		mocks.personalizedItems = undefined
	})

	it('renders the prerendered public recommendation first', () => {
		const markup = renderToStaticMarkup(
			<PersonalizedPostRelatedNewsletter items={publicItems} />,
		)

		expect(markup).toContain('Public result')
	})

	it('uses the completed-content-aware result after hydration', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.personalizedItems = [
			{
				id: 'personalized',
				title: 'Personalized result',
				slug: 'personalized',
				meta: 'Article',
			},
		]

		const markup = renderToStaticMarkup(
			<PersonalizedPostRelatedNewsletter
				items={publicItems}
				personalization={{ postId: 'post-1', variant: 'suggested' }}
			/>,
		)

		expect(markup).toContain('Personalized result')
		expect(markup).not.toContain('Public result')
	})
})
