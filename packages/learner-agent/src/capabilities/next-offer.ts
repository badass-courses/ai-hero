import { Effect, Option, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { OfferPrice, OfferProduct, OfferState, OfferTeam } from '../domain.js'
import { Unavailable } from '../errors.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import {
	LearnerAudit,
	LearnerIdentity,
	LearnerOffers,
	LearnerSite,
} from '../services.js'

export const nextOfferContract = defineContract('next_offer', {
	title: 'Next offer',
	description:
		'The learner’s current offer from AI Hero, priced live by the same rules as checkout: the product, what they pay now in USD cents and why, when that price ends, and when enrollment closes. A learner who owns the product gets no price. An anonymous caller gets the default price. This is the learner’s current offer, which they may ask about.',
	input: Schema.Struct({}),
	output: Schema.Struct({
		state: OfferState,
		product: OfferProduct,
		price: Schema.NullOr(OfferPrice),
		team: Schema.NullOr(OfferTeam),
		next_actions: NextActions,
	}),
	failure: Unavailable,
	annotations: { readOnly: true, idempotent: true },
})

export const nextOffer = implement(nextOfferContract, () =>
	Effect.gen(function* () {
		const identity = yield* LearnerIdentity
		const offers = yield* LearnerOffers
		const site = yield* LearnerSite
		const learner = Option.getOrNull(identity.current)
		const offer = yield* offers.nextOffer(learner)

		if (learner) {
			const audit = yield* LearnerAudit
			yield* audit.read({
				userId: learner.userId,
				capability: 'next_offer',
				resourceId: offer.product.id,
			})
		}

		const { product } = offer
		const next_actions = (() => {
			switch (offer.state) {
				case 'owns':
					return [
						nextTool('office_hours', 'See upcoming live office hours.'),
						product.courseSlug
							? nextTool(
									'course_outline',
									`Open the outline of ${product.title}.`,
									{ course: product.courseSlug },
								)
							: nextTool('my_courses', 'List the courses this learner owns.'),
					]
				case 'not_yet_open':
				case 'closed':
					return [
						nextHref(product.url, `The page for ${product.title}.`),
						nextTool('search_course', 'Search public AI Hero content.', {
							query: '<what to find>',
						}),
					]
				case 'anonymous':
					return [
						nextHref(product.url, `The sales page for ${product.title}.`),
						nextHref(
							site.connectUrl,
							'Signed in, the price accounts for the learner’s earlier AI Hero purchases.',
						),
					]
				case 'alumni':
				case 'standard':
					return [nextHref(product.url, `The sales page for ${product.title}.`)]
			}
		})()

		return {
			state: offer.state,
			product,
			price: offer.state === 'owns' ? null : offer.price,
			team: offer.state === 'owns' ? null : offer.team,
			next_actions,
		}
	}),
)
