import { TeamPageTemplate } from '@/app/(user)/team/page_client'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import {
	getTeamManagerOrganizationsForMember,
	type TeamManagerOrganization,
} from '@/lib/team-manager-directory'
import { getTeamPurchasesForMember } from '@/lib/team-purchases'
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
	}[]
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
		}
	}

	const [teamPurchases, organizations] = await Promise.all([
		getTeamPurchasesForMember(user.id),
		getTeamManagerOrganizationsForMember(user.id),
	])
	const bulkPurchases = await Promise.all(
		teamPurchases.map(async (purchase) => {
			const bulkCoupon = purchase.bulkCouponId
				? await courseBuilderAdapter.getCouponWithBulkPurchases(
						purchase.bulkCouponId,
					)
				: null
			return {
				purchase,
				bulkCoupon: bulkCoupon?.status === 1 ? bulkCoupon : null,
			}
		}),
	)

	return {
		viewer: { id: user.id, email: user.email },
		view: organizations.length > 0 ? 'manager' : 'member',
		organizations,
		bulkPurchases,
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
