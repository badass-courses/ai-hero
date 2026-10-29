import { TeamPageTemplate } from '@/app/(user)/team/page_client'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import {
	getTeamManagerOrganizationsForMember,
	type TeamManagerOrganization,
} from '@/lib/team-manager-directory'
import {
	getTeamCardState,
	getTeamPurchasesForMember,
	getUnlinkedBulkPurchasesForUser,
	type TeamCardState,
	type TeamPurchaseLink,
} from '@/lib/team-purchases'
import {
	loadTeamProgressForViewer,
	type TeamProgressBlock,
} from '@/lib/team-progress'
import { getServerAuthSession } from '@/server/auth'

import type { Coupon, Purchase } from '@coursebuilder/core/schemas'

export type TeamPageData = {
	viewer: {
		id: string
		email: string | null
	} | null
	view: 'anonymous' | 'member' | 'manager'
	organizations: TeamManagerOrganization[]
	bulkPurchases: {
		purchase: Purchase
		bulkCoupon: Coupon | null
		state: TeamCardState
	}[]
	/** PII for managed teams; the viewer's own row elsewhere. */
	teamProgress: TeamProgressBlock[]
}

async function teamPageDataLoader(): Promise<TeamPageData> {
	const { session } = await getServerAuthSession()
	const user = session?.user
	if (!user) {
		return {
			viewer: null,
			view: 'anonymous',
			organizations: [],
			bulkPurchases: [],
			teamProgress: [],
		}
	}

	const [teamPurchases, organizations] = await Promise.all([
		getTeamPurchasesForMember(user.id),
		getTeamManagerOrganizationsForMember(user.id),
	])
	// Read only: a paid pool that no managed organization holds is shown as
	// "being set up". Repairs run elsewhere, never on a page render.
	const unlinkedPurchases = await getUnlinkedBulkPurchasesForUser(
		user.id,
		teamPurchases,
	)
	const bulkPurchases = await Promise.all(
		[
			...teamPurchases.map((purchase) => ({
				purchase,
				link: 'managed' as TeamPurchaseLink,
			})),
			...unlinkedPurchases,
		].map(async ({ purchase, link }) => {
			const bulkCoupon = purchase.bulkCouponId
				? await courseBuilderAdapter.getCouponWithBulkPurchases(
						purchase.bulkCouponId,
					)
				: null
			const activeCoupon = bulkCoupon?.status === 1 ? bulkCoupon : null
			const state = getTeamCardState({
				purchaseStatus: purchase.status,
				link,
				couponActive: Boolean(activeCoupon),
			})
			// Coupon data goes to the client only for a card that offers seats.
			return state === 'active'
				? { purchase, bulkCoupon: activeCoupon, state }
				: {
						purchase: { ...purchase, bulkCoupon: null },
						bulkCoupon: null,
						state,
					}
		}),
	)

	// Managers by organization role, plus the buyer of a pool with no
	// organization, who already sees its claimed seats on the card above.
	const teamProgress = await loadTeamProgressForViewer({
		viewerId: user.id,
		managedPurchases: [
			...teamPurchases,
			...unlinkedPurchases
				.filter(({ link }) => link === 'no-organization')
				.map(({ purchase }) => purchase),
		],
	})

	return {
		viewer: { id: user.id, email: user.email },
		view: organizations.length > 0 ? 'manager' : 'member',
		organizations,
		bulkPurchases,
		teamProgress,
	}
}

export default async function TeamPage() {
	const pageData = await teamPageDataLoader()

	return (
		<LayoutClient withContainer>
			<TeamPageTemplate {...pageData} />
		</LayoutClient>
	)
}
