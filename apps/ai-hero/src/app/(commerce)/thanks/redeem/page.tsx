import * as React from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { purchaseArtwork } from '@/lib/purchase-artwork'

import { PostPurchaseIconBadge } from '../../_components/post-purchase-icon'
import { PostPurchaseLoginLink } from '../../_components/post-purchase-login-link'
import {
	PurchaseCard,
	PurchaseCardSection,
	PurchaseColumn,
	PurchaseHeading,
} from '../../_components/post-purchase-parts'

/**
 * Where a teammate lands after claiming a seat while signed out (signed in,
 * the redeem dialog sends them to `/welcome`). Same card as the purchase
 * screens: the course, then the login link to open.
 *
 * Two reads: the purchase with its user, and the product for its name and
 * artwork.
 */
const ThanksRedeem = async (props: {
	searchParams: Promise<{ purchaseId: string }>
}) => {
	const searchParams = await props.searchParams
	await headers()

	const purchase = await courseBuilderAdapter.getPurchaseWithUser(
		searchParams.purchaseId,
	)

	if (!purchase?.user?.email) {
		return notFound()
	}

	const product = await courseBuilderAdapter.getProduct(purchase.productId)

	return (
		<LayoutClient withContainer>
			<main className="min-h-[calc(100vh-var(--nav-height))]">
				<PurchaseColumn>
					<PurchaseCard>
						<PurchaseCardSection>
							<PurchaseHeading
								artwork={purchaseArtwork(product)}
								badge={<PostPurchaseIconBadge kind="ready" size="sm" />}
								eyebrow="Team seat claimed"
								title={product?.name || 'Your course'}
							/>
						</PurchaseCardSection>
						<PurchaseCardSection>
							<PostPurchaseLoginLink
								email={purchase.user.email}
								supportEmail={env.NEXT_PUBLIC_SUPPORT_EMAIL}
							/>
						</PurchaseCardSection>
					</PurchaseCard>
				</PurchaseColumn>
			</main>
		</LayoutClient>
	)
}

export default ThanksRedeem
