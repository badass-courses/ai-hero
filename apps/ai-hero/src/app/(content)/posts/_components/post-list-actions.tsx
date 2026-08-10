'use client'

import { api } from '@/trpc/react'

import { PostActions } from './post-actions'

export function PostListActions() {
	const { data, status } = api.ability.getPostActionsData.useQuery(undefined, {
		staleTime: 60 * 1000,
		refetchOnWindowFocus: false,
		retry: 1,
	})

	if (status !== 'success' || !data) return null

	return <PostActions allPosts={data.allPosts} allLists={data.allLists} />
}
