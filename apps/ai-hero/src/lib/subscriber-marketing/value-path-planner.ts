import type { OperatorContactSnapshot } from './operator-lookup'
import type { PurchasePreviewPurchase } from './purchase-preview'
import type { ContactEventRecord, ContactState, Gate } from './types'

export const SELLABLE_OFFERS = [
	{
		slug: 'ai-sdk-v6-crash-course',
		productId: 'product-9wdta',
		name: 'AI SDK v6 Crash Course',
		audience: 'individual',
		status: 'sellable',
	},
	{
		slug: 'claude-code-real-engineers-team',
		productId: 'product-7t9ek',
		name: 'Claude Code for Real Engineers, teams 10+',
		audience: 'team-enterprise',
		status: 'human-reviewed-quote',
	},
] as const

export const NON_SELLABLE_VALUE_PATHS = [
	'ai-hero-skills-workflow',
	'ai-hero-skills-team-workflow',
	'ai-sdk-builder-path',
	'team-enablement-path',
	'existing-customer-path',
	'support-access-issue-path',
	'suppress-do-not-market-path',
	'general-nurture-no-active-offer-path',
] as const

export const CONTENT_RESOURCE_BACKED_VALUE_PATHS = [
	{
		slug: 'ai-hero-skills-workflow',
		title: 'AI Hero Skills Workflow',
		audience: 'individual',
		status: 'review-only',
		supersedes: 'ai-sdk-builder-path',
	},
	{
		slug: 'ai-hero-skills-team-workflow',
		title: 'AI Hero Skills Workflow for Teams',
		audience: 'team',
		status: 'review-only',
		supersedes: 'team-enablement-path',
	},
] as const

export type SellableOfferSlug = (typeof SELLABLE_OFFERS)[number]['slug']
export type NonSellableValuePathSlug = (typeof NON_SELLABLE_VALUE_PATHS)[number]
export type ContentResourceBackedValuePathSlug =
	(typeof CONTENT_RESOURCE_BACKED_VALUE_PATHS)[number]['slug']
export type ValuePathSlug = SellableOfferSlug | NonSellableValuePathSlug

export type ValuePathPurchaseFact = Pick<
	PurchasePreviewPurchase,
	| 'productId'
	| 'productName'
	| 'status'
	| 'createdAt'
	| 'totalAmount'
	| 'country'
> & {
	purchaseId?: string
}

export type ValuePathCandidate = {
	path: ValuePathSlug
	offer?: SellableOfferSlug
	status: 'review-only' | 'human-review' | 'blocked' | 'no-active-offer'
	confidence: number
	reviewReasons: string[]
	rationale: string[]
	gates: Gate[]
	metadata: {
		customerVisibleSideEffects: false
		kitWrites: false
		frontWrites: false
		sequenceEnrollment: false
		contactStateWrite: false
		teamSize?: number
		matchedPurchaseProductIds: string[]
		contentResourceBackedPath?: ContentResourceBackedValuePathSlug
	}
}

export type ValuePathPreviewResult = {
	mode: 'value-path-preview'
	privacy: {
		rawPayloadIncluded: false
		rawEmailsIncluded: false
	}
	offerCatalog: typeof SELLABLE_OFFERS
	nonSellableValuePaths: typeof NON_SELLABLE_VALUE_PATHS
	contentResourceBackedValuePaths: typeof CONTENT_RESOURCE_BACKED_VALUE_PATHS
	candidate: ValuePathCandidate
}

export function previewValuePath(args: {
	state: ContactState
	recentEvents?: ContactEventRecord[]
	purchaseFacts?: ValuePathPurchaseFact[]
}): ValuePathPreviewResult {
	const candidate = planValuePathCandidate(args)
	return {
		mode: 'value-path-preview',
		privacy: { rawPayloadIncluded: false, rawEmailsIncluded: false },
		offerCatalog: SELLABLE_OFFERS,
		nonSellableValuePaths: NON_SELLABLE_VALUE_PATHS,
		contentResourceBackedValuePaths: CONTENT_RESOURCE_BACKED_VALUE_PATHS,
		candidate,
	}
}

export function previewValuePathForContactSnapshot(args: {
	snapshot: OperatorContactSnapshot
	purchaseFacts?: ValuePathPurchaseFact[]
}): ValuePathPreviewResult {
	if (!args.snapshot.currentState) {
		return {
			mode: 'value-path-preview',
			privacy: { rawPayloadIncluded: false, rawEmailsIncluded: false },
			offerCatalog: SELLABLE_OFFERS,
			nonSellableValuePaths: NON_SELLABLE_VALUE_PATHS,
			contentResourceBackedValuePaths: CONTENT_RESOURCE_BACKED_VALUE_PATHS,
			candidate: buildCandidate({
				path: 'general-nurture-no-active-offer-path',
				status: 'human-review',
				confidence: 0,
				reviewReasons: ['missing-contact-state'],
				rationale: [
					'No Contact State was found, so the operator should review the contact before planning a value path.',
				],
				matchedPurchaseProductIds: [],
			}),
		}
	}

	return previewValuePath({
		state: args.snapshot.currentState,
		recentEvents: args.snapshot.recentEvents,
		purchaseFacts: args.purchaseFacts,
	})
}

function planValuePathCandidate(args: {
	state: ContactState
	recentEvents?: ContactEventRecord[]
	purchaseFacts?: ValuePathPurchaseFact[]
}): ValuePathCandidate {
	const purchases = args.purchaseFacts ?? []
	const activePurchases = purchases.filter(isActivePurchase)
	const refundedOrDisputed = purchases.filter(isRefundedOrDisputedPurchase)
	const matchedPurchaseProductIds = activePurchases.map(
		(purchase) => purchase.productId,
	)

	if (refundedOrDisputed.length > 0) {
		return buildCandidate({
			path: 'suppress-do-not-market-path',
			status: 'blocked',
			confidence: args.state.confidence,
			reviewReasons: ['refunded-or-disputed-purchase'],
			rationale: [
				'Refunded or disputed purchase facts suppress marketing until a human reviews the account.',
			],
			matchedPurchaseProductIds,
		})
	}

	const teamSize = inferTeamSize(args.recentEvents ?? [])
	const teamSignal =
		args.state.reviewSignals.includes('team-sales') ||
		args.state.whoSignals.includes('technical-team-leader')
	const supportReviewSignals = args.state.reviewSignals.filter(
		(signal) => signal !== 'team-sales',
	)

	if (hasActivePurchase(activePurchases, 'product-9wdta')) {
		return buildCandidate({
			path: 'existing-customer-path',
			status: 'review-only',
			confidence: args.state.confidence,
			reviewReasons: [],
			rationale: [
				'Contact already has an active AI SDK v6 Crash Course purchase, so do not pitch the same individual offer.',
			],
			matchedPurchaseProductIds,
		})
	}

	if (teamSignal && teamSize && teamSize >= 10) {
		return buildCandidate({
			path: 'team-enablement-path',
			contentResourceBackedPath: 'ai-hero-skills-team-workflow',
			offer: 'claude-code-real-engineers-team',
			status: 'human-review',
			confidence: args.state.confidence,
			reviewReasons: ['team-enterprise-human-reviewed-quote'],
			rationale: [
				'Claude Code for Real Engineers is only available as a team or enterprise offer for teams 10+.',
				'Planning stops at human-reviewed sales follow-up, quote, or invoice review.',
			],
			matchedPurchaseProductIds,
			teamSize,
		})
	}

	if (teamSignal) {
		return buildCandidate({
			path: 'team-enablement-path',
			contentResourceBackedPath: 'ai-hero-skills-team-workflow',
			status: 'human-review',
			confidence: args.state.confidence,
			reviewReasons: ['team-size-not-qualified-or-unknown'],
			rationale: [
				'Team interest is present, but the team size is unknown or below the 10+ threshold for the Claude Code team offer.',
			],
			matchedPurchaseProductIds,
			teamSize,
		})
	}

	if (
		supportReviewSignals.length > 0 ||
		(args.state.humanReview && !teamSignal)
	) {
		return buildCandidate({
			path: 'support-access-issue-path',
			status: 'human-review',
			confidence: args.state.confidence,
			reviewReasons: supportReviewSignals.length
				? supportReviewSignals
				: args.state.reviewSignals,
			rationale: [
				'Support, access, restricted, ambiguous, or low-confidence signals route to human review before any marketing plan.',
			],
			matchedPurchaseProductIds,
		})
	}

	if (args.state.whySignals.includes('ai-fundamentals-under-the-hood')) {
		return buildCandidate({
			path: 'ai-sdk-builder-path',
			contentResourceBackedPath: 'ai-hero-skills-workflow',
			offer: 'ai-sdk-v6-crash-course',
			status: 'review-only',
			confidence: args.state.confidence,
			reviewReasons: [],
			rationale: [
				'AI SDK fundamentals interest maps to the active individual AI SDK v6 Crash Course offer.',
			],
			matchedPurchaseProductIds,
		})
	}

	if (
		args.state.whySignals.includes('build-products-apps-prototypes') ||
		args.state.whySignals.includes('agentic-workflows-automation') ||
		args.state.whySignals.includes('ai-coding-workflow-real-engineering')
	) {
		return buildCandidate({
			path: 'ai-sdk-builder-path',
			contentResourceBackedPath: 'ai-hero-skills-workflow',
			offer: 'ai-sdk-v6-crash-course',
			status: 'review-only',
			confidence: args.state.confidence,
			reviewReasons: [],
			rationale: [
				'Builder and AI workflow signals map to the active individual AI SDK v6 Crash Course offer.',
			],
			matchedPurchaseProductIds,
		})
	}

	return buildCandidate({
		path: 'general-nurture-no-active-offer-path',
		status: 'no-active-offer',
		confidence: args.state.confidence,
		reviewReasons: [],
		rationale: [
			'No active sellable offer clearly matches the current Contact State.',
		],
		matchedPurchaseProductIds,
	})
}

function buildCandidate(args: {
	path: ValuePathSlug
	offer?: SellableOfferSlug
	status: ValuePathCandidate['status']
	confidence: number
	reviewReasons: string[]
	rationale: string[]
	matchedPurchaseProductIds: string[]
	teamSize?: number
	contentResourceBackedPath?: ContentResourceBackedValuePathSlug
}): ValuePathCandidate {
	return {
		path: args.path,
		offer: args.offer,
		status: args.status,
		confidence: args.confidence,
		reviewReasons: args.reviewReasons,
		rationale: args.rationale,
		gates: reviewOnlyGates(args.status),
		metadata: {
			customerVisibleSideEffects: false,
			kitWrites: false,
			frontWrites: false,
			sequenceEnrollment: false,
			contactStateWrite: false,
			teamSize: args.teamSize,
			matchedPurchaseProductIds: args.matchedPurchaseProductIds,
			contentResourceBackedPath: args.contentResourceBackedPath,
		},
	}
}

function reviewOnlyGates(status: ValuePathCandidate['status']): Gate[] {
	return [
		{
			slug: 'gate-b-internal-capture',
			passed: true,
			reason: 'Gate B permits review-only internal planning output.',
		},
		{
			slug: 'human-review',
			passed: status === 'review-only' || status === 'no-active-offer',
			reason:
				status === 'human-review' || status === 'blocked'
					? 'Human review is required before any next step.'
					: 'No mandatory review blocker for inspection output.',
		},
		{
			slug: 'customer-visible-side-effects',
			passed: false,
			reason:
				'AIH-117 is review-only. No Kit writes, Front writes, sequence enrollment, Contact State write, or customer-visible side effect is allowed.',
		},
	]
}

function isActivePurchase(purchase: ValuePathPurchaseFact) {
	const status = purchase.status.toLowerCase()
	return !(
		status.includes('refund') ||
		status.includes('dispute') ||
		status.includes('chargeback') ||
		status.includes('canceled') ||
		status.includes('cancelled')
	)
}

function isRefundedOrDisputedPurchase(purchase: ValuePathPurchaseFact) {
	const status = purchase.status.toLowerCase()
	return (
		status.includes('refund') ||
		status.includes('dispute') ||
		status.includes('chargeback')
	)
}

function hasActivePurchase(
	purchases: ValuePathPurchaseFact[],
	productId: string,
) {
	return purchases.some((purchase) => purchase.productId === productId)
}

function inferTeamSize(events: ContactEventRecord[]) {
	const keywords = events.flatMap((event) => event.payloadSummary.keywords)
	const numericSize = keywords
		.map((keyword) => Number(keyword))
		.find((value) => Number.isInteger(value) && value > 0)
	if (numericSize) return numericSize
	if (keywords.some((keyword) => keyword === '10+' || keyword === 'ten'))
		return 10
	if (
		keywords.some((keyword) =>
			['enterprise', 'procurement', 'organization'].includes(keyword),
		)
	) {
		return 10
	}
	return undefined
}
