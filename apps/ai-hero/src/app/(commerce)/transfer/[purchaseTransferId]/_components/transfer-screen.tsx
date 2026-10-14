import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { ArrowRight, Gift } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { PostPurchaseIconBadge } from '../../../_components/post-purchase-icon'
import {
	PURCHASE_GHOST_BUTTON,
	PURCHASE_PRIMARY_BUTTON,
	PurchaseCard,
	PurchaseCardSection,
	PurchaseColumn,
	PurchaseHeading,
	PurchaseNextStep,
} from '../../../_components/post-purchase-parts'
import type { WelcomeStart } from '../../../welcome/welcome-start'
import { TransferAcceptButton, TransferLoginButton } from './transfer-actions'

/**
 * Where the transfer stands for whoever opened the link. `accept` is the
 * recipient, signed in; `sign-in` is anyone else, signed out or in another
 * account, who needs a login link for the recipient's address.
 */
export type TransferView =
	| { kind: 'accept' }
	| { kind: 'sign-in'; viewerEmail: string | null }
	| { kind: 'accepted'; start: WelcomeStart | null; viewerIsRecipient: boolean }
	| { kind: 'canceled' }
	| { kind: 'expired' }

/**
 * The transfer invitation, as one purchase card: what was sent, who sent it,
 * then the one thing to do about it.
 */
export function TransferScreen({
	view,
	transferId,
	productName,
	artwork,
	senderName,
	senderEmail,
	recipientEmail,
	accept,
}: {
	view: TransferView
	transferId: string
	productName: string
	artwork?: string | null
	senderName: string
	senderEmail?: string | null
	recipientEmail: string
	accept?: () => Promise<void>
}) {
	const eyebrow = {
		accept: `Sent to you by ${senderName}`,
		'sign-in': `Sent to you by ${senderName}`,
		accepted: 'Transfer complete',
		canceled: 'Transfer canceled',
		expired: 'Transfer expired',
	}[view.kind]
	const recipient = (
		<strong className="text-foreground break-all font-semibold">
			{recipientEmail}
		</strong>
	)
	const askSender = senderEmail ? (
		<a href={`mailto:${senderEmail}`} className={PURCHASE_GHOST_BUTTON}>
			Email {senderName}
		</a>
	) : null

	return (
		<LayoutClient withContainer>
			<main className="min-h-[calc(100vh-var(--nav-height))]">
				<PurchaseColumn>
					<PurchaseCard>
						<PurchaseCardSection>
							<PurchaseHeading
								artwork={artwork}
								badge={
									view.kind === 'accepted' ? (
										<PostPurchaseIconBadge kind="ready" size="sm" />
									) : null
								}
								eyebrow={eyebrow}
								title={productName}
							>
								{view.kind === 'accepted' && view.start ? (
									<div className="flex flex-col items-start gap-2 pt-3">
										<Link
											href={view.start.href}
											className={PURCHASE_PRIMARY_BUTTON}
										>
											{view.start.label}
											<ArrowRight
												aria-hidden="true"
												className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
											/>
										</Link>
										{view.start.startsLabel ? (
											<p className={cn(TYPE.metaSm, 'text-muted-foreground')}>
												{view.start.startsLabel}
											</p>
										) : null}
									</div>
								) : null}
							</PurchaseHeading>
						</PurchaseCardSection>

						{view.kind === 'accept' ? (
							<PurchaseCardSection>
								<PurchaseNextStep
									icon={
										<span
											aria-hidden="true"
											className="bg-accent-fill text-accent-fill-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-full"
										>
											<Gift className="size-[18px]" strokeWidth={2} />
										</span>
									}
									title="Accept your seat"
									action={
										<form action={accept}>
											<TransferAcceptButton />
										</form>
									}
								>
									<p>
										It moves from {senderName} to your account, {recipient}. By
										accepting, you agree to the{' '}
										<Link
											href="/privacy"
											className="text-foreground underline underline-offset-2"
										>
											terms of AI Hero
										</Link>
										.
									</p>
								</PurchaseNextStep>
							</PurchaseCardSection>
						) : null}

						{view.kind === 'sign-in' ? (
							<PurchaseCardSection>
								<PurchaseNextStep
									icon={<PostPurchaseIconBadge kind="email" />}
									title={<>Sign in as {recipientEmail} to accept</>}
									action={
										<TransferLoginButton
											email={recipientEmail}
											callbackUrl={`/transfer/${transferId}`}
										/>
									}
								>
									<p>
										{view.viewerEmail ? (
											<>
												You&apos;re signed in as{' '}
												<strong className="text-foreground break-all font-semibold">
													{view.viewerEmail}
												</strong>
												. We&apos;ll email a login link to {recipient} that
												signs you in there and brings you back here.
											</>
										) : (
											<>
												We&apos;ll email a login link to {recipient}. It
												brings you back here to accept.
											</>
										)}
									</p>
								</PurchaseNextStep>
							</PurchaseCardSection>
						) : null}

						{view.kind === 'accepted' && !view.viewerIsRecipient ? (
							<PurchaseCardSection>
								<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
									This seat now belongs to {recipient}.
								</p>
							</PurchaseCardSection>
						) : null}

						{view.kind === 'canceled' || view.kind === 'expired' ? (
							<PurchaseCardSection className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
								<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
									{view.kind === 'canceled'
										? `${senderName} canceled this transfer. If that's a surprise, ask them about it.`
										: `This invitation expired before it was accepted. Ask ${senderName} to send a new one.`}
								</p>
								{askSender}
							</PurchaseCardSection>
						) : null}
					</PurchaseCard>
				</PurchaseColumn>
			</main>
		</LayoutClient>
	)
}
