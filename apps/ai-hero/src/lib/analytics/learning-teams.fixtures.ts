import { LEARNING_AS_OF, learningFixture } from './learning-progress.fixtures'
import type { LearningDatabaseFixture } from './learning-progress.mysql-fixture'

const ago = (hours: number) =>
	new Date(LEARNING_AS_OF.getTime() - hours * 3_600_000)
		.toISOString()
		.replace('T', ' ')
		.replace('Z', '')

/**
 * The learning fixture plus two teams on the same product.
 *
 * - Team A (`bulk-coupon`, 5 seats): the base fixture's buyer and seat
 *   holder, a second purchase of three more seats, a member who never signed
 *   in, and a refunded seat holder. Its organization is named from the
 *   buyer's email, as personal organizations are.
 * - Team B (`bulk-coupon-b`, 3 seats): one member who finished the first
 *   workshop.
 */
export const teamFixture = {
	...learningFixture,
	organizations: [
		{ id: 'org-a', name: "buyer@example.test's Team" },
		{ id: 'org-b', name: 'Acme Robotics' },
	],
	users: [
		...learningFixture.users,
		{ id: 'u-seat-idle', emailVerified: null, email: 'idle@example.test' },
		{ id: 'u-seat-refunded', emailVerified: ago(500) },
		{ id: 'u-b-buyer', emailVerified: ago(500) },
		{
			id: 'u-b-member',
			emailVerified: ago(400),
			email: 'member-b@example.test',
			name: 'Bea Member',
		},
	],
	coupons: [
		{ id: 'bulk-coupon', maxUses: 5, usedCount: 3 },
		{ id: 'bulk-coupon-b', maxUses: 3, usedCount: 1 },
	],
	purchases: [
		...learningFixture.purchases.map((purchase) =>
			purchase.id === 'p-team'
				? { ...purchase, organizationId: 'org-a', createdAt: ago(900) }
				: purchase.id === 'p-seat'
					? { ...purchase, createdAt: ago(800) }
					: purchase,
		),
		{
			id: 'p-team-more',
			userId: 'u-team-buyer',
			status: 'Valid',
			bulkCouponId: 'bulk-coupon',
			organizationId: 'org-a',
			createdAt: ago(300),
		},
		{
			id: 'p-seat-idle',
			userId: 'u-seat-idle',
			status: 'Valid',
			redeemedBulkCouponId: 'bulk-coupon',
			totalAmount: 0,
			createdAt: ago(200),
		},
		{
			id: 'p-seat-refunded',
			userId: 'u-seat-refunded',
			status: 'Refunded',
			redeemedBulkCouponId: 'bulk-coupon',
			totalAmount: 0,
			createdAt: ago(150),
		},
		{
			id: 'p-team-b',
			userId: 'u-b-buyer',
			status: 'Valid',
			bulkCouponId: 'bulk-coupon-b',
			organizationId: 'org-b',
			createdAt: ago(100),
		},
		{
			id: 'p-seat-b',
			userId: 'u-b-member',
			status: 'Valid',
			redeemedBulkCouponId: 'bulk-coupon-b',
			totalAmount: 0,
			createdAt: ago(90),
		},
	],
	progress: [
		...learningFixture.progress,
		['u-seat-refunded', 'l-1', ago(2), ago(2)],
		['u-b-member', 'l-1', ago(30), ago(30)],
		['u-b-member', 'l-2', ago(2), ago(2)],
	],
} satisfies LearningDatabaseFixture

const iso = (hours: number) =>
	new Date(LEARNING_AS_OF.getTime() - hours * 3_600_000).toISOString()
const product = { id: learningFixture.productId, name: 'Synthetic Cohort' }

/**
 * Open workshops are w-before (2 lessons) and w-domain (3): 5 open lessons.
 * Team A's u-seat started l-1 72h ago without finishing it; u-seat-idle has
 * nothing. Team B's member completed l-1 and l-2.
 */
export const expectedTeamA = {
	teamId: 'bulk-coupon',
	product,
	purchaseIds: ['p-team', 'p-team-more'],
	purchasedAt: iso(900),
	seats: { bought: 5, redeemed: 3, unredeemed: 2 },
	members: { count: 2, signedIn: 1, neverSignedIn: 1, active7d: 1 },
	completion: { openRequiredLessons: 5, averageShare: 0 },
}

export const expectedTeamB = {
	teamId: 'bulk-coupon-b',
	product,
	purchaseIds: ['p-team-b'],
	purchasedAt: iso(100),
	seats: { bought: 3, redeemed: 1, unredeemed: 2 },
	members: { count: 1, signedIn: 1, neverSignedIn: 0, active7d: 1 },
	completion: { openRequiredLessons: 5, averageShare: 0.4 },
}

export const expectedTeamAMembers = [
	{
		userId: 'u-seat',
		email: 'u-seat@example.test',
		name: null,
		redeemedAt: iso(800),
		signedIn: true,
		lastActiveAt: iso(72),
		lessonsCompleted: 0,
		workshops: { started: 1, completed: 0, total: 4 },
	},
	{
		userId: 'u-seat-idle',
		email: 'idle@example.test',
		name: null,
		redeemedAt: iso(200),
		signedIn: false,
		lastActiveAt: null,
		lessonsCompleted: 0,
		workshops: { started: 0, completed: 0, total: 4 },
	},
]
