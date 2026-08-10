'use client'

import {
	PostNewsletterCell,
	PostNewsletterCellSkeleton,
} from '@/app/(content)/_components/post-related-newsletter'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { isOnEmailList } from '@/lib/cta-gating'
import { useSession } from 'next-auth/react'

/**
 * Reader-dependent half of an article's closing grid. Subscriber and session
 * checks run after hydration so the shared post HTML remains prerenderable.
 */
export function PostClosingNewsletter({ postSlug }: { postSlug: string }) {
	const { subscriber, isResolved } = useCtaGate()
	const { data: session, status: sessionStatus } = useSession()

	if (!isResolved || sessionStatus === 'loading') {
		return <PostNewsletterCellSkeleton />
	}

	if (isOnEmailList(subscriber)) return null

	return (
		<PostNewsletterCell
			trackParams={{ post: postSlug, location: 'post' }}
			knownIdentity={
				subscriber?.hasIdentity === true || Boolean(session?.user?.email)
			}
		/>
	)
}
