import type { PricingResultData } from '@ai-hero/front-desk-support/pricing'

/**
 * Front-desk's engine 0.2.0 vector (engine-0.2.0-ppp-credit-bounded.json):
 * a regional buyer whose Crash Course credit is PaymentAmbiguous. Its request
 * facts were alumni none, credit PaymentAmbiguous, creditUse available, no
 * seats, legend no, individual, PPP accepted at 75%.
 */
export const PPP_CREDIT_BOUNDED_RESULT = {
	amount: 32375,
	basis: 'ppp',
	consent: 'region',
	creditSource: null,
	quoteRefs: [],
	restriction: 'region',
	rule: 'ppp',
	unitAmount: 32375,
	acceptedFacts: [
		{ fact: 'alumni', productRefs: [] },
		{ fact: 'creditUse', productRefs: [] },
		{ fact: 'existingSeats', productRefs: [] },
		{
			fact: 'legend',
			productRefs: [
				'product:product-3vfob',
				'product:product-7t9ek',
				'product:product-9wdta',
				'product:product-ma254',
				'product:product-pqkk5',
				'product:product-wdhub',
			],
		},
		{ fact: 'order', productRefs: [] },
		{ fact: 'ppp', productRefs: [] },
	],
	candidates: [
		{
			amount: 32375,
			basis: 'ppp',
			consent: 'region',
			creditSource: null,
			quoteRefs: [],
			restriction: 'region',
			rule: 'ppp',
			unitAmount: 32375,
		},
		{
			amount: 90650,
			basis: 'formula',
			consent: null,
			creditSource: null,
			quoteRefs: [],
			restriction: 'none',
			rule: 'new',
			unitAmount: 90650,
		},
	],
	engineVersion: '0.2.0',
	offers: [],
	policyVersion: 'aihero-cohort-005@2026-10-26.credit-off-regional',
	reasons: [
		{ code: 'early-window', detail: '' },
		{ code: 'fact-unknown', detail: 'credit: PaymentAmbiguous' },
		{ code: 'selected', detail: 'ppp' },
	],
	kind: 'bounded',
	unresolved: [
		{
			candidate: 'credit',
			fact: 'credit',
			gap: 'PaymentAmbiguous',
			needs: 'credit: the settled Crash Course payment',
		},
	],
} as const satisfies PricingResultData
