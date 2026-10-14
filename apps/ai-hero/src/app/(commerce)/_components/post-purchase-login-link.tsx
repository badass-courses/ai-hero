import { PostPurchaseIconBadge } from './post-purchase-icon'
import { PurchaseNextStep } from './post-purchase-parts'

/**
 * The one thing a buyer without a session has left to do. It replaces the
 * shared kit's login-link block, which said it three times over (a "Final
 * step" label, a headline, then a paragraph repeating the address).
 */
export function PostPurchaseLoginLink({
	email,
	supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
}: {
	email?: string | null
	supportEmail?: string
}) {
	return (
		<PurchaseNextStep
			icon={<PostPurchaseIconBadge kind="email" />}
			title="Open the login link we emailed you"
		>
			<p>
				Sent to{' '}
				{email ? (
					<strong className="text-foreground font-semibold break-all">
						{email}
					</strong>
				) : (
					'your inbox'
				)}
				{supportEmail ? (
					<>
						{' '}
						from{' '}
						<strong className="text-foreground font-semibold">
							{supportEmail}
						</strong>
					</>
				) : null}
				. It signs you in so you can start learning.
			</p>
		</PurchaseNextStep>
	)
}
