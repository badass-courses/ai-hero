import type { SurfaceName } from '@/lib/analytics'
import { PROMO_KINDS } from '@/lib/analytics/promos'

export const ANALYTICS_SCHEMA_VERSION = '2026-11-01.1'

export const ANALYTICS_AGENT_INSTRUCTIONS = [
	'Revenue amounts are USD major units. Treat database revenue surfaces as the revenue source of truth, not GA4.',
	'Use the same range and productId when comparing summary with revenue/daily. Requests at different times can include different purchases.',
	'Read summary revenue from data.totalRevenue. Read daily revenue from data[].revenue. There is no totalRevenue field on revenue/daily rows.',
	'The 100-row purchases/recent limit is a per-page cap, not a total cap. Read meta.pagination.totalMatchingRows for the full matching count. Follow _links.next.href until it is absent, or meta.pagination.nextOffset until it is null. meta.totalRows is the current page size.',
	'Absent productId means all products on product-aware surfaces. Published revenue schemas list productId support, and some attribution surfaces also accept it.',
	'purchases/recent defaults to range=30d. Use range=all when historical purchases are required.',
	'Treat each response as a point-in-time read. Re-query before reporting live launch numbers.',
	'For attribution/email-campaigns and /strict, inspect data.provider. When provider is drovr, read broadcasts.rows[].result.status before counters. Unavailable is not zero. Status counters are lifetime actor-reported sent counts for explicitly configured references, not deliveries or a complete list of sends. receiptSample is a capped latest journey-transition sample, not broadcast receipts or reconciliation. Engagement, unsubscribes and attributed revenue are unavailable. historical is a frozen Kit-era export at its own asOf and original range/mode/product scope, never current drovr results. productId scopes historical strict snapshots only, not current broadcast statuses.',
	'learning/progress requires productId and ignores range. Divide funnel started/completed by data.funnel.denominator.count (signed-in learners), not roster.learners. Report locked rows as locked, never as 0% completion. Read data.asOf; results are cached for data.refreshSeconds (five minutes, or fifteen above 5,000 learners).',
	'learning/teams and learning/team are aggregate team reads; a team id is a bulk coupon id. learning/team divides funnel counts by data.funnel.denominator.count (team members). Unredeemed seats are a count, never members with zero progress.',
	'For newsletter signups (AI Hero is off Kit), use newsletter/signups. It always covers the last 30 UTC days and ignores range. Read data.totals.last7 and data.totals.last30; when totals.complete is false, say how many of totals.days were reported and that partial days (today) are still counting. A day with status unavailable is unknown, never zero. A SIGNUPS_UNAVAILABLE error means no number is known.',
	'learning/team-members is PII: learner emails and names. Only AI Hero admins may read it, every read is logged with the actor and team, and it is never cached. Do not copy member rows into public, shared or long-lived places; summarize with learning/team instead.',
] as const

const usd = (description: string) => ({
	type: 'number',
	unit: 'USD',
	description,
})

const count = (description: string) => ({
	type: 'integer',
	minimum: 0,
	description,
})

const promoMetrics = {
	type: 'object',
	additionalProperties: false,
	required: [
		'kind',
		'currency',
		'recordCount',
		'purchaseCount',
		'gross',
		'refunds',
		'net',
	],
	properties: {
		kind: { type: 'string', enum: PROMO_KINDS },
		currency: { const: 'USD' },
		recordCount: count('All records, including seat/zero and unclassified'),
		purchaseCount: count(
			'Positive Valid, Restricted and Refunded purchases, excluding team-seat redemptions',
		),
		gross: usd(
			'Original paid amounts, including subsequently refunded purchases',
		),
		refunds: usd(
			'Refunded purchase amounts, dated by purchase creation, not refund time',
		),
		net: usd('gross minus refunds'),
	},
} as const

const learningAvailability = {
	oneOf: [
		{
			type: 'object',
			additionalProperties: false,
			required: ['status'],
			properties: { status: { const: 'available' } },
		},
		{
			type: 'object',
			additionalProperties: false,
			required: ['status', 'reason'],
			properties: {
				status: { const: 'locked' },
				reason: { enum: ['unpublished', 'scheduled'] },
			},
		},
	],
} as const

const learningFunnelRow = {
	type: 'object',
	additionalProperties: false,
	required: [
		'id',
		'kind',
		'workshopId',
		'title',
		'slug',
		'state',
		'startsAt',
		'availability',
		'requiredLessons',
		'started',
		'completed',
	],
	properties: {
		id: { type: 'string', description: 'Content resource id' },
		kind: { enum: ['workshop', 'section'] },
		workshopId: { type: ['string', 'null'] },
		title: { type: 'string' },
		slug: { type: ['string', 'null'] },
		state: { type: ['string', 'null'] },
		startsAt: { type: ['string', 'null'] },
		availability: learningAvailability,
		requiredLessons: count('Lessons a learner must complete'),
		started: count('Learners in the denominator with any progress here'),
		completed: count(
			'Learners in the denominator who completed every required lesson',
		),
	},
} as const

const learningProgressSchema = {
	supports: ['productId'],
	requires: ['productId'],
	data: {
		type: 'object',
		additionalProperties: false,
		required: [
			'asOf',
			'refreshSeconds',
			'product',
			'roster',
			'funnel',
			'activity',
		],
		properties: {
			asOf: { type: 'string', format: 'date-time' },
			refreshSeconds: {
				enum: [300, 900],
				description:
					'Cache lifetime of this read: 900 above 5,000 learners, else 300',
			},
			product: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'name', 'type'],
				properties: {
					id: { type: 'string' },
					name: { type: 'string' },
					type: { type: ['string', 'null'] },
				},
			},
			roster: {
				type: 'object',
				additionalProperties: false,
				required: [
					'learners',
					'bySource',
					'signedIn',
					'neverSignedIn',
					'removed',
					'teamSeatsUnredeemed',
				],
				properties: {
					learners: count(
						'Distinct users with Valid or Restricted access, redeemed team seats included',
					),
					bySource: {
						type: 'object',
						additionalProperties: false,
						required: ['purchased', 'teamSeat'],
						properties: {
							purchased: count('Learners holding their own purchase'),
							teamSeat: count(
								'Learners whose only access is a redeemed team seat',
							),
						},
					},
					signedIn: count(
						'Learners with sign-in evidence. The funnel denominator.',
					),
					neverSignedIn: count('learners minus signedIn'),
					removed: {
						type: 'object',
						additionalProperties: false,
						required: ['refunded', 'transferredAway'],
						properties: {
							refunded: count(
								'Users with a Refunded purchase and no current access',
							),
							transferredAway: count(
								'Source users of completed purchase transfers who no longer hold access',
							),
						},
					},
					teamSeatsUnredeemed: count(
						'Open seats on Valid or Restricted team purchases (maxUses minus usedCount)',
					),
				},
			},
			funnel: {
				type: 'object',
				additionalProperties: false,
				required: ['denominator', 'rows'],
				properties: {
					denominator: {
						type: 'object',
						additionalProperties: false,
						required: ['basis', 'count'],
						properties: {
							basis: { const: 'signed-in-learners' },
							count: count('Equals roster.signedIn'),
						},
					},
					rows: {
						type: 'array',
						items: learningFunnelRow,
					},
				},
			},
			activity: {
				type: 'object',
				additionalProperties: false,
				required: [
					'lessonsCompleted24h',
					'lessonsCompleted7d',
					'activeLearners7d',
					'totalLessonCompletions',
				],
				properties: {
					lessonsCompleted24h: count(
						'Lesson completions by learners in the 24h before asOf',
					),
					lessonsCompleted7d: count(
						'Lesson completions by learners in the 7d before asOf',
					),
					activeLearners7d: count(
						'Learners with any progress write in the 7d before asOf',
					),
					totalLessonCompletions: count(
						'All current lesson completions by learners',
					),
				},
			},
		},
	},
	semantics: [
		'Aggregate only. No user ids, emails or names, and productId is the only filter.',
		"Learners hold a Valid or Restricted purchase of the product, matching the access rule. A team buyer's bulk purchase grants no access; each redeemed seat is its own purchase.",
		'Sign-in evidence is a verified email, a linked OAuth account, a current session, or any lesson progress. Expired sessions are deleted, so legacy sign-ins with none of these count as never signed in.',
		'Rows follow product order: each workshop, then its sections. A cohort contributes its workshops. Required lessons follow the certificate rule: undeleted lesson and exercise links in the workshop or its sections, optional lessons excluded. Lesson publish state is not a filter because managed cohort lessons stay draft.',
		'Every row uses the same denominator, so a learner can be counted in a later row without earlier ones.',
		'A row is locked when its workshop is not published (reason unpublished) or its startsAt is in the future (reason scheduled). Locked rows still carry their counts.',
		"Activity counts only progress on the product's required lessons by current learners. Windows end at asOf.",
		'Certificates are not reported: eligibility is computed on demand and no certificate table exists.',
	],
} as const

const learningProduct = {
	type: 'object',
	additionalProperties: false,
	required: ['id', 'name'],
	properties: { id: { type: 'string' }, name: { type: 'string' } },
} as const

const learningSeats = {
	type: 'object',
	additionalProperties: false,
	required: ['bought', 'redeemed', 'unredeemed'],
	properties: {
		bought: count("The team coupon's maxUses"),
		redeemed: count("The team coupon's usedCount"),
		unredeemed: count('bought minus redeemed, never below zero'),
	},
} as const

const learningTeamSummary = {
	type: 'object',
	additionalProperties: false,
	required: [
		'teamId',
		'product',
		'purchaseIds',
		'purchasedAt',
		'seats',
		'members',
		'completion',
	],
	properties: {
		teamId: { type: 'string', description: 'The bulk coupon id' },
		product: learningProduct,
		purchaseIds: {
			type: 'array',
			items: { type: 'string' },
			description: 'Bulk purchase ids behind the team, oldest first',
		},
		purchasedAt: { type: 'string', format: 'date-time' },
		seats: learningSeats,
		members: {
			type: 'object',
			additionalProperties: false,
			required: ['count', 'signedIn', 'neverSignedIn', 'active7d'],
			properties: {
				count: count(
					'Users holding a Valid or Restricted redeemed seat now. Can trail seats.redeemed after refunds.',
				),
				signedIn: count('Members with sign-in evidence'),
				neverSignedIn: count('count minus signedIn'),
				active7d: count(
					"Members with any progress write on the product's required lessons in the 7d before asOf",
				),
			},
		},
		completion: {
			type: 'object',
			additionalProperties: false,
			required: ['openRequiredLessons', 'averageShare'],
			properties: {
				openRequiredLessons: count(
					'Required lessons in workshops open to learners at asOf',
				),
				averageShare: {
					type: ['number', 'null'],
					minimum: 0,
					maximum: 1,
					description:
						'Mean share of open required lessons each member completed. Null with no members or no open lessons.',
				},
			},
		},
	},
} as const

const learningTeamsSchema = {
	supports: ['productId'],
	data: {
		type: 'object',
		additionalProperties: false,
		required: ['asOf', 'productId', 'teams'],
		properties: {
			asOf: { type: 'string', format: 'date-time' },
			productId: { type: ['string', 'null'] },
			teams: {
				type: 'array',
				items: learningTeamSummary,
				description: 'Newest purchase first',
			},
		},
	},
	semantics: [
		'Aggregate only. No member ids, emails or names, and no organization names: personal organizations are named from the buyer email.',
		'A team is one bulk coupon. Extra seat purchases for the same organization and product share it, so purchaseIds can hold several ids.',
		'Only teams with a Valid or Restricted bulk purchase are listed.',
	],
} as const

const learningTeamSchema = {
	supports: ['teamId'],
	requires: ['teamId'],
	data: {
		type: 'object',
		additionalProperties: false,
		required: ['asOf', 'team', 'funnel', 'activity'],
		properties: {
			asOf: { type: 'string', format: 'date-time' },
			team: learningTeamSummary,
			funnel: {
				type: 'object',
				additionalProperties: false,
				required: ['denominator', 'rows'],
				properties: {
					denominator: {
						type: 'object',
						additionalProperties: false,
						required: ['basis', 'count'],
						properties: {
							basis: { const: 'team-members' },
							count: count('Equals team.members.count'),
						},
					},
					rows: { type: 'array', items: learningFunnelRow },
				},
			},
			activity: learningProgressSchema.data.properties.activity,
		},
	},
	semantics: [
		'teamId is a bulk coupon id, or any bulk purchase id of the team.',
		'The funnel follows learning/progress rules with team members as the denominator, signed in or not.',
	],
} as const

const learningTeamMembersSchema = {
	supports: ['teamId'],
	requires: ['teamId'],
	pii: true,
	data: {
		type: 'object',
		additionalProperties: false,
		required: ['asOf', 'pii', 'team', 'members'],
		properties: {
			asOf: { type: 'string', format: 'date-time' },
			pii: { const: true },
			team: {
				type: 'object',
				additionalProperties: false,
				required: ['teamId', 'product', 'seats', 'organization'],
				properties: {
					teamId: { type: 'string' },
					product: learningProduct,
					seats: learningSeats,
					organization: {
						oneOf: [
							{ type: 'null' },
							{
								type: 'object',
								additionalProperties: false,
								required: ['id', 'name'],
								properties: {
									id: { type: 'string' },
									name: {
										type: ['string', 'null'],
										description: 'PII: can contain the buyer email',
									},
								},
							},
						],
					},
				},
			},
			members: {
				type: 'array',
				description:
					'PII. One row per redeemed seat held now, oldest redemption first. Unredeemed seats are team.seats.unredeemed, never rows.',
				items: {
					type: 'object',
					additionalProperties: false,
					required: [
						'userId',
						'email',
						'name',
						'redeemedAt',
						'signedIn',
						'lastActiveAt',
						'lessonsCompleted',
						'workshops',
					],
					properties: {
						userId: { type: 'string' },
						email: { type: ['string', 'null'], description: 'PII' },
						name: { type: ['string', 'null'], description: 'PII' },
						redeemedAt: { type: 'string', format: 'date-time' },
						signedIn: { type: 'boolean' },
						lastActiveAt: {
							type: ['string', 'null'],
							format: 'date-time',
							description:
								"Latest progress write on the product's required lessons",
						},
						lessonsCompleted: count(
							'Completed required lessons in the product, locked workshops included',
						),
						workshops: {
							type: 'object',
							additionalProperties: false,
							required: ['started', 'completed', 'total'],
							properties: {
								started: count('Workshops with any progress'),
								completed: count(
									'Workshops with every required lesson completed',
								),
								total: count('Workshops in the product'),
							},
						},
					},
				},
			},
		},
	},
	semantics: [
		'PII: learner emails and names. AI Hero admins only (manage all); analytics-only roles are refused.',
		'Never cached. Responses are Cache-Control: private, no-store and carry no CORS allowance.',
		'Every read is logged with the actor id, auth method and teamId. Member emails are never logged.',
		'Certificates are not reported: no certificate table exists.',
	],
} as const

const signupCounts = {
	total: count('New subscribers'),
	bySource: {
		type: 'object',
		additionalProperties: count('New subscribers from this source'),
		description:
			'ai-hero = site signups, kit = Kit-only arrivals, list-import = imported lists, unknown = no source. Sums to total.',
	},
} as const
const signupTotal = {
	type: 'object',
	additionalProperties: false,
	required: [
		'days',
		'reportedDays',
		'partialDays',
		'complete',
		'subscribed',
		'confirmed',
		'unsubscribed',
	],
	properties: {
		days: count('UTC days in the span'),
		reportedDays: count('Days drovr reported; the sums cover only these'),
		partialDays: count('Reported days still counting, such as today'),
		complete: { type: 'boolean' },
		subscribed: {
			type: 'object',
			required: ['total', 'bySource'],
			properties: signupCounts,
		},
		confirmed: { type: ['integer', 'null'], minimum: 0 },
		unsubscribed: { type: ['integer', 'null'], minimum: 0 },
	},
} as const

export const REVENUE_SURFACE_SCHEMAS = {
	'newsletter/signups': {
		supports: [],
		data: {
			type: 'object',
			additionalProperties: false,
			required: ['provider', 'asOf', 'from', 'to', 'days', 'sources', 'totals'],
			properties: {
				provider: { const: 'drovr' },
				asOf: { type: 'string', format: 'date-time' },
				from: { type: 'string', format: 'date' },
				to: { type: 'string', format: 'date' },
				days: {
					type: 'array',
					items: {
						type: 'object',
						required: ['day', 'status'],
						properties: {
							day: { type: 'string', format: 'date' },
							status: { enum: ['complete', 'partial', 'unavailable'] },
							subscribed: { type: 'object', properties: signupCounts },
							confirmed: { type: ['integer', 'null'], minimum: 0 },
							unsubscribed: { type: ['integer', 'null'], minimum: 0 },
						},
					},
				},
				sources: { type: 'array', items: { type: 'string' } },
				totals: {
					type: 'object',
					required: ['last7', 'last30'],
					properties: { last7: signupTotal, last30: signupTotal },
				},
			},
		},
		semantics: [
			'Source: drovr GET /signup-counts for tenant org-aihero. Counts and source names only, no contact identities.',
			'days covers every UTC day from..to, oldest first. status unavailable means drovr did not vouch for that day: unknown, not zero, and excluded from totals.',
			'status partial means the day is still counting (today so far). Totals include partial days and say so in partialDays.',
			'confirmed and unsubscribed are null when drovr did not report them.',
			'A failed or timed-out drovr read (10 s) returns ok:false with code SIGNUPS_UNAVAILABLE and HTTP 503.',
		],
	},
	'learning/progress': learningProgressSchema,
	'learning/teams': learningTeamsSchema,
	'learning/team': learningTeamSchema,
	'learning/team-members': learningTeamMembersSchema,
	'revenue/promos': {
		supports: ['range', 'from', 'to', 'productId'],
		data: {
			type: 'object',
			additionalProperties: false,
			required: ['currency', 'window', 'byKind', 'daily'],
			properties: {
				currency: { const: 'USD' },
				window: {
					type: 'object',
					additionalProperties: false,
					required: ['from', 'to', 'basis', 'bounds'],
					properties: {
						from: { type: ['string', 'null'], format: 'date-time' },
						to: { type: 'string', format: 'date-time' },
						basis: { const: 'purchase-created' },
						bounds: { const: '[from,to)' },
					},
				},
				byKind: { type: 'array', items: promoMetrics },
				daily: {
					type: 'array',
					items: {
						...promoMetrics,
						required: [...promoMetrics.required, 'date'],
						properties: {
							...promoMetrics.properties,
							date: { type: 'string', format: 'date' },
						},
					},
				},
			},
		},
		semantics: [
			'USD major units. No customer identifiers. SQL groups by UTC purchase-created day and promo kind.',
			'Precedence: seat-or-zero; invalid amount or unknown status -> unclassified; evergreen; regional; unresolved coupon -> unclassified; other-coupon; full-price.',
			'Evergreen means the linked site coupon has fields.evergreenOffer present, including null or false. Coupon status/expiry and arbitrary merchant offer types do not rewrite historical attribution.',
			'Regional means Restricted, or a linked merchant coupon of type ppp (also preserves regional attribution on Refunded rows when that link exists).',
			'Classification uses persisted coupon evidence only. A refunded row cannot recover a previous Restricted status without a persisted PPP coupon link. An unrecorded merchant discount cannot be inferred from the paid amount.',
			'Unknown purchase statuses (including Disputed and Banned) are unclassified and excluded from paid money, matching the base revenue provider. Status comparisons are byte-exact. Unresolved coupon references are unclassified, not full-price. recordCount makes every record visible.',
			'purchaseCount counts positive Valid/Restricted/Refunded records except team-seat redemptions. Seat/zero and unknown statuses never contribute paid amounts.',
			'gross includes original amounts of Refunded purchases; refunds includes their amounts; net = gross - refunds. Refunds are dated by purchase creation, not refund time. Partial Stripe refund events are not represented by this purchase-status report.',
			'from/to must be supplied together as UTC ISO timestamps (Z, at most millisecond precision), using half-open [from,to) bounds, max 400 days. Explicit windows override the rolling range, and the envelope echoes window instead of range. range=all without an explicit window is rejected with a 400; paired from/to override range=all. Use 24h/7d/30d/90d or paired from/to. Other surfaces reject from/to.',
		],
	},
	'funnel/evergreen': {
		supports: ['range', 'from', 'to', 'productId'],
		data: {
			oneOf: [
				{
					type: 'object',
					additionalProperties: false,
					required: ['status', 'reason'],
					properties: {
						status: { const: 'pending' },
						reason: { type: 'string' },
					},
				},
				{
					type: 'object',
					additionalProperties: false,
					required: ['status', 'daily'],
					properties: {
						status: { const: 'ready' },
						daily: {
							type: 'array',
							items: {
								type: 'object',
								additionalProperties: false,
								required: [
									'date',
									'entered',
									'clicked',
									'boughtWithCoupon',
									'boughtWithout',
									'productMatched',
								],
								properties: {
									date: { type: 'string', format: 'date' },
									entered: count('Entered journey'),
									clicked: count('Clicked offer'),
									boughtWithCoupon: count('Bought with offer coupon'),
									boughtWithout: count('Bought without offer coupon'),
									productMatched: count(
										'Purchases matched to the offered product',
									),
								},
							},
						},
					},
				},
			],
		},
		semantics: [
			'Currently returns only { status: pending, reason }. No journey provider calls. Conversion remains typed pending, never zero, until an aggregate read lands.',
		],
	},
	summary: {
		supports: ['range', 'productId'],
		data: {
			type: 'object',
			additionalProperties: false,
			required: ['totalRevenue', 'purchaseCount', 'avgOrderValue'],
			properties: {
				totalRevenue: usd('Paid purchase revenue for the selected filters'),
				purchaseCount: count('Paid purchase records for the selected filters'),
				avgOrderValue: usd('totalRevenue divided by purchaseCount'),
			},
		},
		semantics: [
			'Use data.totalRevenue for the revenue total.',
			'Use the same range and productId to reconcile with revenue/daily.',
		],
	},
	'revenue/daily': {
		supports: ['range', 'productId'],
		data: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['date', 'revenue', 'count'],
				properties: {
					date: {
						type: 'string',
						format: 'date',
						description: 'Purchase database calendar date',
					},
					revenue: usd('Paid purchase revenue for this date'),
					count: count('Paid purchase records for this date'),
				},
			},
		},
		semantics: [
			'Read revenue from data[].revenue, not totalRevenue.',
			'The sum of rows reconciles with summary when both requests use the same filters and data snapshot.',
		],
	},
	'revenue/products': {
		supports: ['range', 'productId'],
		data: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['productId', 'productName', 'revenue', 'count'],
				properties: {
					productId: { type: 'string' },
					productName: { type: 'string' },
					revenue: usd('Paid purchase revenue for this product'),
					count: count('Paid purchase records for this product'),
				},
			},
		},
		semantics: [
			'Without productId, rows are ordered by revenue descending across all products.',
		],
	},
	'revenue/countries': {
		supports: ['range', 'productId'],
		data: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['country', 'revenue', 'count'],
				properties: {
					country: {
						type: 'string',
						description: 'Purchase country or (unknown)',
					},
					revenue: usd('Paid purchase revenue for this country'),
					count: count('Paid purchase records for this country'),
				},
			},
		},
		semantics: ['Rows are ordered by revenue descending and limited to 20.'],
	},
	'purchases/recent': {
		supports: ['range', 'productId', 'limit', 'offset'],
		order: ['createdAt desc', 'id desc'],
		pagination: {
			limitMaximum: 100,
			currentPageCount: 'meta.pagination.returnedRows',
			totalMatchingCount: 'meta.pagination.totalMatchingRows',
			nextPage: '_links.next.href',
			previousPage: '_links.previous.href',
		},
		data: {
			type: 'array',
			items: {
				type: 'object',
				required: [
					'id',
					'createdAt',
					'totalAmount',
					'productName',
					'productId',
				],
				properties: {
					id: { type: 'string' },
					createdAt: { type: 'string', format: 'date-time' },
					totalAmount: usd('Paid amount for this purchase'),
					productName: { type: 'string' },
					productId: { type: 'string' },
					country: { type: ['string', 'null'] },
					couponId: { type: ['string', 'null'] },
					userName: { type: ['string', 'null'] },
					userEmail: { type: ['string', 'null'], format: 'email' },
					isTeam: {
						type: 'boolean',
						description:
							'True only when the purchase has a bulk coupon with more than one seat. An organization alone does not make a purchase a team purchase.',
					},
					seats: {
						type: ['integer', 'null'],
						minimum: 2,
						description:
							'Seats bought by this purchase. Set only for a team purchase that is the only purchase on its bulk coupon. Null for individual purchases and for add-seat teams, where the per-purchase count is not stored.',
					},
					teamSeats: {
						type: ['integer', 'null'],
						minimum: 2,
						description:
							"The team's current total seats, its bulk coupon's maxUses today, for any team purchase. Null for individual purchases.",
					},
				},
			},
		},
		semantics: [
			'Rows are newest first. Large historical purchases do not outrank newer purchases.',
			'The 100-row limit is per page. Follow _links.next.href until absent, or meta.pagination.nextOffset until null.',
			'Read meta.pagination.totalMatchingRows for the full matching purchase count. meta.totalRows and meta.pagination.returnedRows describe only the current page.',
			'A team purchase is one with a bulk coupon of more than one seat. Add-seat purchases reuse the team coupon and raise its total, so seats is null when a coupon has more than one purchase, and teamSeats is the team total now, not at purchase time.',
		],
	},
} as const

export type RevenueSurfaceName = keyof typeof REVENUE_SURFACE_SCHEMAS

export function getRevenueSurfaceSchema(surface: SurfaceName) {
	return REVENUE_SURFACE_SCHEMAS[surface as RevenueSurfaceName] as
		| (typeof REVENUE_SURFACE_SCHEMAS)[RevenueSurfaceName]
		| undefined
}

export function getAnalyticsAgentSchema(surfaceNames: readonly SurfaceName[]) {
	return {
		version: ANALYTICS_SCHEMA_VERSION,
		dialect: 'https://json-schema.org/draft/2020-12/schema',
		query: {
			type: 'object',
			additionalProperties: false,
			required: ['surface'],
			properties: {
				surface: {
					type: 'string',
					enum: surfaceNames,
					description: 'Analytics surface to query',
				},
				range: {
					type: 'string',
					enum: ['24h', '7d', '30d', '90d', '180d', 'all'],
					default: '30d',
					description:
						'Rolling lookback. 180d is only valid for GA4 traffic surfaces.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					default: 20,
					description:
						'Max 100 generally. Max 1000 only for surveys/responses.',
				},
				offset: {
					type: 'integer',
					minimum: 0,
					default: 0,
				},
				from: {
					type: 'string',
					format: 'date-time',
					description:
						'revenue/promos and funnel/evergreen only. Inclusive UTC ISO instant, supply with to.',
				},
				to: {
					type: 'string',
					format: 'date-time',
					description:
						'Exclusive UTC ISO instant, supply with from. Max 400-day explicit window.',
				},
				productId: { type: 'string' },
				teamId: {
					type: 'string',
					description:
						'learning/team and learning/team-members. A bulk coupon id or bulk purchase id.',
				},
				purchaseId: { type: 'string' },
				surveyId: { type: 'string' },
				surveySlug: { type: 'string' },
				questionId: { type: 'string' },
			},
			allOf: [
				{
					if: {
						properties: {
							surface: { enum: ['revenue/promos', 'funnel/evergreen'] },
						},
						required: ['surface'],
						not: { required: ['from', 'to'] },
					},
					then: {
						properties: { range: { enum: ['24h', '7d', '30d', '90d'] } },
					},
				},
				{
					if: {
						properties: { surface: { const: 'surveys/responses' } },
						required: ['surface'],
					},
					then: { properties: { limit: { maximum: 1000 } } },
					else: { properties: { limit: { maximum: 100 } } },
				},
				{
					if: {
						properties: { surface: { const: 'learning/progress' } },
						required: ['surface'],
					},
					then: { required: ['productId'] },
				},
				{
					if: {
						properties: {
							surface: { enum: ['learning/team', 'learning/team-members'] },
						},
						required: ['surface'],
					},
					then: { required: ['teamId'] },
				},
			],
		},
		surfaces: REVENUE_SURFACE_SCHEMAS,
	}
}
