import type {
	EvergreenOfferJourneyDefinition,
	MessageDefinition,
} from './domain'
import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
} from './domain'
import {
	parseContentResourceId,
	parseMessageSlotId,
	parsePresentationBundleId,
	type ParseResult,
} from './primitives'

const DIRECT_BUNDLE_ID = must(parsePresentationBundleId('direct_v1'))

function message(args: {
	slotId: string
	contentResourceId: string
	subjectId: string
	headlineId: string
	openingId: string
	ctaId: string
}): MessageDefinition {
	return {
		slotId: must(parseMessageSlotId(args.slotId)),
		contentResourceId: must(parseContentResourceId(args.contentResourceId)),
		presentation: {
			bundleId: DIRECT_BUNDLE_ID,
			subjectId: args.subjectId,
			headlineId: args.headlineId,
			openingId: args.openingId,
			ctaId: args.ctaId,
		},
	}
}

// Approved in aihero-support at presentation review 02a94431 and pinned by
// approval receipt 88920819. Changing any field requires a new reviewed plan.
export const EVERGREEN_OFFER_JOURNEY_V1 = {
	definitionVersion: 'evergreen-offer-v1',
	messagePlanId: 'crash_course_evergreen_presentation_v1',
	messagePlanSourceHash:
		'7097327f4c1a175a91835f838ac629694e38e8bb40b3817b2e831f4d1a029b4b',
	contentRevision: '1afe22601ccd5641cec04a4ad94963d6a816316f',
	presentationReviewRevision:
		'02a944318ccd1c2d8b9f6028ccf09067cf02bd83',
	bridge: [
		message({
			slotId: 'B1',
			contentResourceId: 'bridge_can_engineer_v1',
			subjectId: 'b1_subject_direct',
			headlineId: 'b1_headline_direct',
			openingId: 'b1_opening_direct',
			ctaId: 'b1_cta_direct',
		}),
		message({
			slotId: 'B2',
			contentResourceId: 'bridge_real_codebase_v1',
			subjectId: 'b2_subject_direct',
			headlineId: 'b2_headline_direct',
			openingId: 'b2_opening_direct',
			ctaId: 'b2_cta_none',
		}),
		message({
			slotId: 'B3',
			contentResourceId: 'bridge_keep_skills_v1',
			subjectId: 'b3_subject_direct',
			headlineId: 'b3_headline_direct',
			openingId: 'b3_opening_direct',
			ctaId: 'b3_cta_none',
		}),
	],
	pitch: [
		message({
			slotId: 'P1',
			contentResourceId: 'pitch_open_product_origin_v1',
			subjectId: 'p1_subject_direct',
			headlineId: 'p1_headline_direct',
			openingId: 'p1_opening_direct',
			ctaId: 'p1_cta_direct',
		}),
		message({
			slotId: 'P2',
			contentResourceId: 'pitch_watch_feature_build_v1',
			subjectId: 'p2_subject_direct',
			headlineId: 'p2_headline_direct',
			openingId: 'p2_opening_direct',
			ctaId: 'p2_cta_direct',
		}),
		message({
			slotId: 'P3',
			contentResourceId: 'pitch_self_paced_faq_v1',
			subjectId: 'p3_subject_direct',
			headlineId: 'p3_headline_direct',
			openingId: 'p3_opening_direct',
			ctaId: 'p3_cta_direct',
		}),
		message({
			slotId: 'P4',
			contentResourceId: 'pitch_proof_last_day_v1',
			subjectId: 'p4_subject_direct',
			headlineId: 'p4_headline_direct',
			openingId: 'p4_opening_direct',
			ctaId: 'p4_cta_direct',
		}),
		message({
			slotId: 'P5',
			contentResourceId: 'pitch_final_notice_v1',
			subjectId: 'p5_subject_direct',
			headlineId: 'p5_headline_direct',
			openingId: 'p5_opening_direct',
			ctaId: 'p5_cta_direct',
		}),
	],
	couponTerms: {
		productId: EVERGREEN_OFFER_PRODUCT_ID,
		currency: EVERGREEN_OFFER_CURRENCY,
		amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
		maxUses: EVERGREEN_OFFER_MAX_USES,
		exclusive: true,
	},
} as const satisfies EvergreenOfferJourneyDefinition

function must<Value>(result: ParseResult<Value>): Value {
	if (!result.ok) {
		throw new Error(
			`Invalid evergreen journey definition field: ${result.error.field}`,
		)
	}
	return result.value
}
