import type { ContactState, Gate } from './types'

export type ValuePathSendGateMode =
	| 'dry-run'
	| 'allowlisted-test'
	| 'scoped-live'

export type ValuePathSendGateInput = {
	mode?: ValuePathSendGateMode
	contactId: string
	kitSubscriberId?: string
	email?: string
	valuePathSlug: string
	emailResourceId: string
	kitSequenceId?: string
	humanReview?: boolean
	lifecycle?:
		| 'new'
		| 'classified'
		| 'nurture-ready'
		| 'human-review'
		| 'suppressed'
		| 'customer'
		| 'stale'
	reviewSignals?: ContactState['reviewSignals']
	unsubscribed?: boolean
	bounced?: boolean
	complained?: boolean
	identityConflict?: boolean
	allowlistedContactIds?: string[]
	allowlistedKitSubscriberIds?: string[]
	allowlistedEmails?: string[]
	enabledValuePathSlugs?: string[]
	verifiedEmailResourceIds?: string[]
	verifiedKitSequenceIds?: string[]
}

export type ValuePathSendGateDecision = {
	passed: boolean
	mode: ValuePathSendGateMode
	gates: Gate[]
	reviewReasons: string[]
	advisoryReasons: string[]
	rationale: string[]
}

export function shouldBlockValuePathForContactState(
	state?: Pick<ContactState, 'humanReview' | 'lifecycle' | 'reviewSignals'>,
) {
	if (!state) return false
	if (state.lifecycle === 'suppressed' || state.lifecycle === 'stale')
		return true
	if (!state.humanReview && state.lifecycle !== 'human-review') return false
	return (
		valuePathStopReasonsFromReviewSignals(state.reviewSignals).stopReasons
			.length > 0
	)
}

export function evaluateValuePathEmailSendGate(
	input: ValuePathSendGateInput,
): ValuePathSendGateDecision {
	const mode = input.mode ?? 'dry-run'
	const reviewReasons: string[] = []
	const advisoryReasons: string[] = []
	const rationale: string[] = []

	if (mode === 'dry-run') {
		reviewReasons.push('mode-dry-run')
		rationale.push('Dry-run mode produces receipts and never enrolls Kit.')
	}

	if (input.humanReview || input.lifecycle === 'human-review') {
		advisoryReasons.push('human-review')
	}
	const reviewSignalReasons = valuePathStopReasonsFromReviewSignals(
		input.reviewSignals ?? [],
	)
	reviewReasons.push(...reviewSignalReasons.stopReasons)
	advisoryReasons.push(...reviewSignalReasons.advisoryReasons)
	if (input.lifecycle === 'suppressed') reviewReasons.push('suppressed')
	if (input.lifecycle === 'stale') reviewReasons.push('stale-state')
	if (input.unsubscribed) reviewReasons.push('unsubscribed')
	if (input.bounced) reviewReasons.push('bounced')
	if (input.complained) reviewReasons.push('complained')
	if (input.identityConflict) reviewReasons.push('identity-conflict')
	if (!input.kitSequenceId) reviewReasons.push('kit-sequence-missing')

	if (mode === 'allowlisted-test' && !isAllowlisted(input)) {
		reviewReasons.push('contact-not-allowlisted')
	} else if (mode === 'allowlisted-test') {
		rationale.push('Contact is allowlisted for value path test sends.')
	}

	if (
		mode === 'allowlisted-test' &&
		input.enabledValuePathSlugs &&
		!input.enabledValuePathSlugs.includes(input.valuePathSlug)
	) {
		reviewReasons.push('value-path-not-allowlisted')
	}
	if (
		mode === 'allowlisted-test' &&
		input.verifiedEmailResourceIds &&
		!input.verifiedEmailResourceIds.includes(input.emailResourceId)
	) {
		reviewReasons.push('email-resource-not-allowlisted')
	}
	if (
		mode === 'allowlisted-test' &&
		input.verifiedKitSequenceIds &&
		input.kitSequenceId &&
		!input.verifiedKitSequenceIds.includes(input.kitSequenceId)
	) {
		reviewReasons.push('kit-sequence-not-allowlisted')
	}

	if (mode === 'scoped-live') {
		if (!input.enabledValuePathSlugs?.includes(input.valuePathSlug)) {
			reviewReasons.push('value-path-not-enabled')
		}
		if (!input.verifiedEmailResourceIds?.includes(input.emailResourceId)) {
			reviewReasons.push('email-resource-not-verified')
		}
		if (
			input.kitSequenceId &&
			!input.verifiedKitSequenceIds?.includes(input.kitSequenceId)
		) {
			reviewReasons.push('kit-sequence-not-verified')
		}
		if (reviewReasons.length === 0) {
			rationale.push('Scoped live send is enabled for this path and email.')
		}
	}

	return buildValuePathSendGateDecision({
		mode,
		reviewReasons,
		advisoryReasons,
		rationale,
	})
}

export function applyAcceptedValuePathSendGateReviewReasons(
	decision: ValuePathSendGateDecision,
	acceptedReviewReasons: string[],
): ValuePathSendGateDecision {
	if (acceptedReviewReasons.length === 0) return decision
	const accepted = new Set(acceptedReviewReasons)
	const reviewReasons = decision.reviewReasons.filter(
		(reason) => !accepted.has(reason),
	)
	const advisoryReasons = decision.advisoryReasons.filter(
		(reason) => !accepted.has(reason),
	)
	const acceptedReasons = [
		...decision.reviewReasons,
		...decision.advisoryReasons,
	].filter((reason) => accepted.has(reason))
	return buildValuePathSendGateDecision({
		mode: decision.mode,
		reviewReasons,
		advisoryReasons,
		rationale: [
			...decision.rationale,
			...acceptedReasons.map(
				(reason) => `Review reason accepted by operator: ${reason}.`,
			),
		],
	})
}

function buildValuePathSendGateDecision(args: {
	mode: ValuePathSendGateMode
	reviewReasons: string[]
	advisoryReasons?: string[]
	rationale: string[]
}): ValuePathSendGateDecision {
	const reviewReasons = unique(args.reviewReasons)
	const advisoryReasons = unique(args.advisoryReasons ?? [])
	const passed = reviewReasons.length === 0
	return {
		passed,
		mode: args.mode,
		gates: [
			{
				slug: 'gate-d-value-path-email',
				passed,
				reason: passed
					? 'Value path email send gate passed.'
					: `Value path email send blocked: ${reviewReasons.join(', ')}`,
			},
		],
		reviewReasons,
		advisoryReasons,
		rationale: args.rationale,
	}
}

function valuePathStopReasonsFromReviewSignals(
	reviewSignals: ContactState['reviewSignals'],
) {
	const stopReasons: string[] = []
	const advisoryReasons: string[] = []
	for (const signal of reviewSignals) {
		if (signal === 'support') stopReasons.push('support-intent')
		else if (signal === 'team-sales') stopReasons.push('team-sales-intent')
		else advisoryReasons.push(`review-signal-${signal}`)
	}
	return { stopReasons, advisoryReasons }
}

function isAllowlisted(input: ValuePathSendGateInput) {
	const email = input.email?.trim().toLowerCase()
	return Boolean(
		input.allowlistedContactIds?.includes(input.contactId) ||
		(input.kitSubscriberId &&
			input.allowlistedKitSubscriberIds?.includes(input.kitSubscriberId)) ||
		(email &&
			input.allowlistedEmails
				?.map((item) => item.toLowerCase())
				.includes(email)),
	)
}

function unique(values: string[]) {
	return Array.from(new Set(values))
}
