import * as LoginLink from '@coursebuilder/commerce-next/post-purchase/login-link'
import { PostPurchaseIconBadge } from './post-purchase-icon'

export function PostPurchaseLoginLink({ email }: { email: string }) {
	return (
		<LoginLink.Root email={email} className="border-b pb-5">
			<LoginLink.Status />
			<LoginLink.Title />
			<LoginLink.CTA className="mt-4 inline-flex items-center gap-3">
				<PostPurchaseIconBadge kind="email" />
				<span>
					Login link sent to: <strong className="font-semibold">{email}</strong>
				</span>
			</LoginLink.CTA>
			<LoginLink.Description className="text-sm opacity-75 sm:text-base" />
		</LoginLink.Root>
	)
}
