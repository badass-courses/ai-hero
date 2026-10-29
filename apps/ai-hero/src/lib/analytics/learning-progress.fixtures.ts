/**
 * One synthetic cohort product that covers every rule the learning progress
 * surface promises. Shared by the pure and MySQL suites so both prove the
 * same expectations.
 */
export const LEARNING_AS_OF = new Date('2026-10-29T12:00:00.000Z')
const ago = (hours: number) =>
	new Date(LEARNING_AS_OF.getTime() - hours * 3_600_000)
		.toISOString()
		.replace('T', ' ')
		.replace('Z', '')

export const learningFixture = {
	productId: 'synthetic-cohort-product',
	product: { name: 'Synthetic Cohort', type: 'cohort' },
	resources: [
		{
			id: 'cohort',
			type: 'cohort',
			fields: { title: 'Cohort', slug: 'cohort' },
		},
		{
			id: 'w-before',
			type: 'workshop',
			fields: {
				title: 'Before We Start',
				slug: 'before',
				state: 'published',
				startsAt: null,
			},
		},
		{
			id: 'w-domain',
			type: 'workshop',
			fields: {
				title: 'Domain Language',
				slug: 'domain',
				state: 'published',
				startsAt: '2026-10-01T16:00:00.000Z',
			},
		},
		{
			id: 's-terms',
			type: 'section',
			fields: { title: 'Terms', slug: 'terms' },
		},
		{
			id: 's-models',
			type: 'section',
			fields: { title: 'Models', slug: 'models' },
		},
		{
			id: 'w-draft',
			type: 'workshop',
			fields: { title: 'Draft Workshop', slug: 'draft', state: 'draft' },
		},
		{
			id: 'w-scheduled',
			type: 'workshop',
			fields: {
				title: 'Scheduled Workshop',
				slug: 'scheduled',
				state: 'published',
				startsAt: '2026-11-20T16:00:00.000Z',
			},
		},
		{ id: 'l-1', type: 'lesson', fields: { title: 'L1', state: 'draft' } },
		{ id: 'l-2', type: 'lesson', fields: { title: 'L2', state: 'draft' } },
		{ id: 'l-3', type: 'lesson', fields: { title: 'L3' } },
		{ id: 'l-4', type: 'exercise', fields: { title: 'L4' } },
		{ id: 'l-5', type: 'lesson', fields: { title: 'L5' } },
		{
			id: 'l-optional',
			type: 'lesson',
			fields: { title: 'Optional', optional: true },
		},
		{
			id: 'l-removed',
			type: 'lesson',
			fields: { title: 'Removed from module' },
		},
		{ id: 'l-8', type: 'lesson', fields: { title: 'L8' } },
		{ id: 'l-9', type: 'lesson', fields: { title: 'L9' } },
	],
	/** [parent, child, position, deleted] */
	links: [
		['cohort', 'w-before', 0, false],
		['cohort', 'w-domain', 1, false],
		['cohort', 'w-draft', 2, false],
		['cohort', 'w-scheduled', 3, false],
		['w-before', 'l-1', 0, false],
		['w-before', 'l-2', 1, false],
		['w-domain', 's-terms', 0, false],
		['w-domain', 's-models', 1, false],
		['w-domain', 'l-optional', 2, false],
		['w-domain', 'l-removed', 3, true],
		['s-terms', 'l-3', 0, false],
		['s-terms', 'l-4', 1, false],
		['s-models', 'l-5', 0, false],
		['w-draft', 'l-8', 0, false],
		['w-scheduled', 'l-9', 0, false],
	] as const,
	users: [
		{ id: 'u-complete', emailVerified: ago(500) },
		{ id: 'u-skipper', emailVerified: null, account: true },
		{ id: 'u-seat', emailVerified: null, session: true },
		{ id: 'u-team-buyer', emailVerified: ago(500) },
		{ id: 'u-refunded', emailVerified: ago(500) },
		{ id: 'u-never', emailVerified: null },
		{ id: 'u-transfer-source', emailVerified: ago(500) },
		{ id: 'u-transfer-target', emailVerified: ago(100) },
		{ id: 'u-admin', emailVerified: ago(500) },
	],
	coupons: [{ id: 'bulk-coupon', maxUses: 5, usedCount: 1 }],
	purchases: [
		{ id: 'p-complete', userId: 'u-complete', status: 'Valid' },
		{ id: 'p-skipper', userId: 'u-skipper', status: 'Valid' },
		{
			id: 'p-seat',
			userId: 'u-seat',
			status: 'Valid',
			redeemedBulkCouponId: 'bulk-coupon',
			totalAmount: 0,
		},
		{
			id: 'p-team',
			userId: 'u-team-buyer',
			status: 'Valid',
			bulkCouponId: 'bulk-coupon',
		},
		{ id: 'p-refunded', userId: 'u-refunded', status: 'Refunded' },
		{ id: 'p-never', userId: 'u-never', status: 'Restricted' },
		{ id: 'p-transferred', userId: 'u-transfer-target', status: 'Valid' },
		{
			id: 'p-other-product',
			userId: 'u-admin',
			status: 'Valid',
			productId: 'another-product',
		},
	],
	transfers: [
		{
			id: 't-1',
			purchaseId: 'p-transferred',
			sourceUserId: 'u-transfer-source',
			targetUserId: 'u-transfer-target',
			transferState: 'COMPLETED',
		},
	],
	/** [userId, lessonId, createdAt, completedAt] */
	progress: [
		['u-complete', 'l-1', ago(48), ago(48)],
		['u-complete', 'l-2', ago(1), ago(1)],
		['u-complete', 'l-8', ago(240), ago(240)],
		// A learner who reaches a later workshop without the earlier one.
		['u-skipper', 'l-3', ago(3), ago(3)],
		['u-skipper', 'l-4', ago(3), ago(3)],
		['u-skipper', 'l-5', ago(3), ago(3)],
		['u-seat', 'l-1', ago(72), null],
		// Refunded and non-buyer progress never counts.
		['u-refunded', 'l-1', ago(1), ago(1)],
		['u-admin', 'l-2', ago(1), ago(1)],
	] as const,
}

export const expectedLearningProgress = {
	asOf: LEARNING_AS_OF.toISOString(),
	product: {
		id: learningFixture.productId,
		name: 'Synthetic Cohort',
		type: 'cohort',
	},
	roster: {
		learners: 5,
		bySource: { purchased: 4, teamSeat: 1 },
		signedIn: 4,
		neverSignedIn: 1,
		removed: { refunded: 1, transferredAway: 1 },
		teamSeatsUnredeemed: 4,
	},
	funnel: {
		denominator: { basis: 'signed-in-learners', count: 4 },
		rows: [
			{
				id: 'w-before',
				kind: 'workshop',
				workshopId: null,
				title: 'Before We Start',
				slug: 'before',
				state: 'published',
				startsAt: null,
				availability: { status: 'available' },
				requiredLessons: 2,
				started: 2,
				completed: 1,
			},
			{
				id: 'w-domain',
				kind: 'workshop',
				workshopId: null,
				title: 'Domain Language',
				slug: 'domain',
				state: 'published',
				startsAt: '2026-10-01T16:00:00.000Z',
				availability: { status: 'available' },
				requiredLessons: 3,
				started: 1,
				completed: 1,
			},
			{
				id: 's-terms',
				kind: 'section',
				workshopId: 'w-domain',
				title: 'Terms',
				slug: 'terms',
				state: 'published',
				startsAt: '2026-10-01T16:00:00.000Z',
				availability: { status: 'available' },
				requiredLessons: 2,
				started: 1,
				completed: 1,
			},
			{
				id: 's-models',
				kind: 'section',
				workshopId: 'w-domain',
				title: 'Models',
				slug: 'models',
				state: 'published',
				startsAt: '2026-10-01T16:00:00.000Z',
				availability: { status: 'available' },
				requiredLessons: 1,
				started: 1,
				completed: 1,
			},
			{
				id: 'w-draft',
				kind: 'workshop',
				workshopId: null,
				title: 'Draft Workshop',
				slug: 'draft',
				state: 'draft',
				startsAt: null,
				availability: { status: 'locked', reason: 'unpublished' },
				requiredLessons: 1,
				started: 1,
				completed: 1,
			},
			{
				id: 'w-scheduled',
				kind: 'workshop',
				workshopId: null,
				title: 'Scheduled Workshop',
				slug: 'scheduled',
				state: 'published',
				startsAt: '2026-11-20T16:00:00.000Z',
				availability: { status: 'locked', reason: 'scheduled' },
				requiredLessons: 1,
				started: 0,
				completed: 0,
			},
		],
	},
	activity: {
		lessonsCompleted24h: 4,
		lessonsCompleted7d: 5,
		activeLearners7d: 3,
		totalLessonCompletions: 6,
	},
}
