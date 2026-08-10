'use client'

import type { ReactNode } from 'react'
import {
	PostRelatedNewsletter,
	type PostRelatedItem,
} from '@/app/(content)/_components/post-related-newsletter'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

export type RelatedPostPersonalization = {
	postId: string
	variant: 'section' | 'suggested'
	sectionTitle?: string
	documentIdsToSkip?: string[]
}

/**
 * Starts with cacheable public recommendations, then replaces them with the
 * existing completed-content-aware result for a signed-in reader.
 */
export function PersonalizedPostRelatedNewsletter({
	items,
	personalization,
	newsletter,
	...props
}: {
	items: PostRelatedItem[]
	personalization?: RelatedPostPersonalization
	newsletter?: ReactNode
	id?: string
	completesResourceId?: string
}) {
	const { status: sessionStatus } = useSession()
	const { data: personalizedItems } =
		api.typesense.getRelatedPostItems.useQuery(
			personalization ?? { postId: '', variant: 'suggested' },
			{
				enabled: sessionStatus === 'authenticated' && Boolean(personalization),
				staleTime: 5 * 60 * 1000,
				refetchOnWindowFocus: false,
				retry: 1,
			},
		)

	return (
		<PostRelatedNewsletter
			{...props}
			items={personalizedItems ?? items}
			newsletter={newsletter}
		/>
	)
}
