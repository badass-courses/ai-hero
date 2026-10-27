import Link from 'next/link'
import { Icon } from '@/components/brand/icons'

import {
	PURCHASE_GHOST_BUTTON,
	PurchaseNextStep,
} from '../_components/post-purchase-parts'

/**
 * Discord goes through the managed `/discord` link flow, never a direct
 * OAuth sign-in, so the server role is granted with the account link.
 */
export function PostPurchaseDiscordAccess({
	isDiscordConnected,
}: {
	isDiscordConnected: boolean
}) {
	if (isDiscordConnected) return null

	return (
		<PurchaseNextStep
			icon={
				<span
					aria-hidden="true"
					className="bg-muted text-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-full"
				>
					<Icon name="Discord" size="20" />
				</span>
			}
			title="Join the Discord"
			action={
				<Link href="/discord" className={PURCHASE_GHOST_BUTTON}>
					Join Discord
				</Link>
			}
		>
			<p>Link your Discord account to get into the AI Hero server.</p>
		</PurchaseNextStep>
	)
}
