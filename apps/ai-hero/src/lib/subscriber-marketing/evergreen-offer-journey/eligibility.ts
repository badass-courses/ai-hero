import type { EligibilityDecision, EligibilityFacts } from './domain'

export function decideEvergreenOfferEligibility(
	facts: EligibilityFacts,
): EligibilityDecision {
	if (facts.automationControl.type === 'Stopped') {
		return ineligible('AutomationStopped', facts)
	}
	if (facts.purchase) return ineligible('ExistingPurchase', facts)
	if (facts.existingJourneyId) return ineligible('ExistingJourney', facts)
	switch (facts.delivery.type) {
		case 'Eligible':
			return { type: 'Eligible', evidenceVersion: facts.evidenceVersion }
		case 'Unsubscribed':
			return ineligible('Unsubscribed', facts)
		case 'Suppressed':
			return ineligible('Suppressed', facts)
		case 'Undeliverable':
			return ineligible('Undeliverable', facts)
		default: {
			const unreachable: never = facts.delivery
			return unreachable
		}
	}
}

function ineligible(
	reason: Extract<EligibilityDecision, { type: 'Ineligible' }>['reason'],
	facts: EligibilityFacts,
): EligibilityDecision {
	return { type: 'Ineligible', reason, evidenceVersion: facts.evidenceVersion }
}
