import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import {
	delayedPaymentCopy,
	type DelayedPaymentState,
} from '../thanks/purchase/delayed-payment-state'
import {
	PURCHASE_GHOST_BUTTON,
	PURCHASE_PRIMARY_BUTTON,
	PurchaseCard,
	PurchaseCardSection,
	PurchaseColumn,
} from './post-purchase-parts'

/**
 * Shown after checkout when the money has not arrived yet (bank transfer) or
 * Stripe reported it failed. No progress bar: nothing will change on this
 * screen until the bank settles, and the buyer gets an email when it does.
 */
export function PostPurchaseDelayedPayment({
	state,
	supportEmail,
}: {
	state: Exclude<DelayedPaymentState, { kind: 'not_delayed' }>
	supportEmail?: string
}) {
	const copy = delayedPaymentCopy(state)
	const instructionsUrl =
		state.kind === 'awaiting_payment' ? state.instructionsUrl : null
	return (
		<LayoutClient withContainer>
			<main
				data-delayed-payment={state.kind}
				className="min-h-[calc(100vh-var(--nav-height))]"
			>
				<PurchaseColumn>
					<PurchaseCard>
						<PurchaseCardSection className="flex flex-col gap-3">
							<p className={cn(TYPE.eyebrow, 'mb-0')}>{copy.eyebrow}</p>
							<h1 className={cn(TYPE.panelTitle, 'text-balance')}>
								{copy.title}
							</h1>
							{copy.body.map((paragraph) => (
								<p
									key={paragraph}
									className={cn(
										TYPE.metaProse,
										'text-muted-foreground max-w-[52ch]',
									)}
								>
									{paragraph}
								</p>
							))}
							<div className="flex flex-wrap gap-3 pt-3">
								{instructionsUrl && copy.instructionsLabel ? (
									<a
										href={instructionsUrl}
										target="_blank"
										rel="noopener noreferrer"
										className={PURCHASE_PRIMARY_BUTTON}
									>
										{copy.instructionsLabel}
									</a>
								) : null}
								<a
									href={`mailto:${supportEmail ?? 'support@aihero.dev'}`}
									className={cn(PURCHASE_GHOST_BUTTON, 'h-[46px] px-6')}
								>
									Contact support
								</a>
							</div>
						</PurchaseCardSection>
					</PurchaseCard>
				</PurchaseColumn>
			</main>
		</LayoutClient>
	)
}
