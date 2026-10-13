import * as LoginLink from '@coursebuilder/commerce-next/post-purchase/login-link'
import { PostPurchaseIcon } from './post-purchase-icon'

export function PostPurchaseLoginLink({ email }: { email: string }) {
	return (
		<LoginLink.Root email={email} className="border-b pb-5">
			<LoginLink.Status />
			<LoginLink.Title />
			<LoginLink.CTA className="mt-4 inline-flex items-center gap-3">
				<div className="bg-primary/20 text-primary flex h-10 w-10 items-center justify-center rounded-full p-3">
					<PostPurchaseIcon kind="email" className="h-4 w-4" />
				</div>
				<span>
					Login link sent to: <strong className="font-semibold">{email}</strong>
				</span>
			</LoginLink.CTA>
			<LoginLink.Description className="text-sm opacity-75 sm:text-base" />
		</LoginLink.Root>
	)
}
