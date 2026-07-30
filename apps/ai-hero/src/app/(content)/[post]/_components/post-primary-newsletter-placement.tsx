import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import type { ResolvedPostCta } from '@/lib/post-cta'

export function PostPrimaryNewsletterPlacement({
	postSlug,
	resolvedCta,
}: {
	postSlug: string
	resolvedCta: ResolvedPostCta
}) {
	if (resolvedCta.kind === 'course') {
		return null
	}

	return (
		<PrimaryNewsletterCta
			isHiddenForSubscribers
			className="mt-20 border-t pt-14 sm:pb-5 sm:pt-20"
			trackProps={{
				event: 'subscribed',
				params: {
					post: postSlug,
					location: 'post',
				},
			}}
		/>
	)
}
