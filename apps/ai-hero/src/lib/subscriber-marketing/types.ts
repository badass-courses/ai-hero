export const CONTACT_EVENT_SCHEMA_VERSION = 1 as const
export const CONTACT_STATE_SCHEMA_VERSION = 1 as const
export const LOW_CONFIDENCE_REVIEW_THRESHOLD = 0.8 as const

export type Provider = 'fixture' | 'front' | 'kit' | 'ai-hero'
export type PrivacyLevel = 'public' | 'internal' | 'restricted'
export type ContactLifecycle =
	| 'new'
	| 'classified'
	| 'nurture-ready'
	| 'human-review'
	| 'suppressed'
	| 'customer'
	| 'stale'
export type SideEffectIntentStatus =
	| 'dry-run'
	| 'gated'
	| 'blocked'
	| 'pending'
	| 'completed'
	| 'failed'
	| 'skipped'
export type NextActionStatus = 'planned' | 'blocked' | 'noop'
export type ReviewSignalSlug =
	| 'buying'
	| 'team-sales'
	| 'support'
	| 'partnership'
	| 'sponsorship'
	| 'emotional'
	| 'ambiguous'
	| 'low-confidence'
	| 'restricted-payload'

export type ContactIdentityEvidence = {
	email?: string
	name?: string
	userId?: string
	providerIdentity?: {
		provider: Provider
		externalId: string
	}
	source: Provider
	strength: 'weak' | 'medium' | 'strong'
}

export type PayloadSummary = {
	summary: string
	keywords: string[]
	restrictedPayloadStored: false
}

import type { OptInAttribution } from './opt-in-attribution'

export type FixtureContactEventInput = {
	provider: Provider
	providerEventId: string
	eventType: string
	occurredAt: string
	email?: string
	name?: string
	userId?: string
	externalId?: string
	message: string
	privacyLevel?: PrivacyLevel
	optInAttribution?: OptInAttribution
}

export type NormalizedContactEvent = {
	provider: Provider
	providerEventId: string
	providerReference: string
	eventType: string
	occurredAt: string
	semanticIdempotencyKey: string
	privacyLevel: PrivacyLevel
	identityEvidence: ContactIdentityEvidence
	payloadSummary: PayloadSummary
	optInAttribution?: OptInAttribution
	schemaVersion: typeof CONTACT_EVENT_SCHEMA_VERSION
}

export type WhySignalSlug =
	| 'ai-coding-workflow-real-engineering'
	| 'agentic-workflows-automation'
	| 'professional-relevance-team-adoption'
	| 'build-products-apps-prototypes'
	| 'content-research-knowledge-work'
	| 'cut-through-overwhelm-build-judgment'
	| 'ai-fundamentals-under-the-hood'
	| 'other-unclear'

export type WhoSignalSlug =
	| 'professional-software-engineer'
	| 'technical-team-leader'
	| 'educator-content-community-builder'
	| 'nontraditional-early-technical-learner'
	| 'data-research-ai-practitioner'
	| 'founder-product-builder'
	| 'unclear'

export type BucketSlug = WhySignalSlug | WhoSignalSlug

export type ClassificationResult = {
	whySignals: WhySignalSlug[]
	whoSignals: WhoSignalSlug[]
	primaryBucket: BucketSlug
	allBuckets: BucketSlug[]
	confidence: number
	rationale: string[]
	reviewSignals: ReviewSignalSlug[]
	humanReview: boolean
}

export type ContactRecord = {
	id: string
	userId?: string | null
	email?: string | null
	name?: string | null
	lifecycle: ContactLifecycle
	isProvisional: boolean
	optInAttribution?: OptInAttribution | null
	createdAt: string
	updatedAt: string
}

export type ProviderIdentityRecord = {
	id: string
	contactId: string
	provider: Provider
	externalId: string
	evidence: ContactIdentityEvidence
	createdAt: string
	updatedAt: string
}

export type ContactLinkRecord = {
	id: string
	contactId: string
	userId: string
	reason: string
	evidence: ContactIdentityEvidence | Record<string, unknown>
	createdAt: string
}

export type ContactEventRecord = NormalizedContactEvent & {
	id: string
	contactId: string
	providerIdentityId: string
	createdAt: string
}

export type ContactState = {
	id: string
	contactId: string
	lifecycle: ContactLifecycle
	primaryBucket: BucketSlug
	allBuckets: BucketSlug[]
	whySignals: WhySignalSlug[]
	whoSignals: WhoSignalSlug[]
	confidence: number
	rationale: string[]
	reviewSignals: ReviewSignalSlug[]
	humanReview: boolean
	optInAttribution?: OptInAttribution | null
	lastEventId: string
	schemaVersion: typeof CONTACT_STATE_SCHEMA_VERSION
	updatedAt: string
}

export type StateTransition = {
	id: string
	contactId: string
	fromStateId?: string
	toStateId: string
	eventId: string
	signals: ClassificationResult
	rationale: string[]
	createdAt: string
}

export type Gate = {
	slug:
		| 'gate-a-dry-run'
		| 'gate-b-internal-capture'
		| 'gate-c-shadow-fields'
		| 'human-review'
		| 'customer-visible-side-effects'
		| 'gate-d-value-path-email'
		| 'email-7-copy-approval'
	passed: boolean
	reason: string
}

export type NextAction = {
	id: string
	contactId: string
	contactStateId: string
	eventId: string
	type:
		| 'do-nothing'
		| 'human-review'
		| 'set-shadow-fields'
		| 'recommend-resource'
		| 'enter-value-path'
		| 'advance-value-path'
		| 'ask-follow-up'
	status: NextActionStatus
	gates: Gate[]
	reviewReasons: string[]
	rationale: string[]
	createdAt: string
}

export type SideEffectIntent = {
	id: string
	nextActionId: string
	contactId: string
	provider: 'dry-run' | 'kit'
	type:
		| 'none'
		| 'human-review'
		| 'preview-shadow-field-sync'
		| 'write-value-path-finisher-fields'
		| 'send-value-path-email'
	status: SideEffectIntentStatus
	completedAt?: string | null
	idempotencyKey: string
	gates: Gate[]
	reviewReasons: string[]
	metadata: Record<string, unknown>
	createdAt: string
}

export type IdentityResolution = {
	contact: ContactRecord
	providerIdentity: ProviderIdentityRecord
	createdContact: boolean
	createdProviderIdentity: boolean
}

export type DryRunInspection = {
	mode: 'dry-run'
	idempotentNoop: boolean
	contact: ContactRecord
	providerIdentity: ProviderIdentityRecord
	contactEvent: ContactEventRecord
	classification: ClassificationResult
	contactState: ContactState
	stateTransition?: StateTransition
	nextAction: NextAction
	sideEffectIntents: SideEffectIntent[]
	privacy: {
		rawPayloadIncluded: false
		payloadSummaryOnly: true
	}
}
