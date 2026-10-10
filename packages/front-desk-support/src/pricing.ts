// front-desk's pricing engine and Cohort 005 rule code, vendored as its
// public build (`vendor/front-desk-pricing`, pinned in SOURCE.json). It holds
// no policy data: the policy and binding quotes arrive at runtime from
// front-desk and go through `decodePolicy` and `decodeBindingQuotes`.
// Effect 4 stays inside the bundle; every export here is plain data.
export {
	ENGINE_VERSION,
	decodeBindingQuotes,
	decodePolicy,
	price,
} from '../vendor/front-desk-pricing/pricing.js'
export type * from '../vendor/front-desk-pricing/types.js'
