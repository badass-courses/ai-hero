import { createHash, createHmac } from 'node:crypto'
import type { contactEvent } from '@/db/schema'
import { z } from 'zod'

export const EMAIL_TOKEN_LOGIN_OBSERVED = 'auth.email_token_login_observed.v1'
export const OFFER_CLAIM_OBSERVED = 'evergreen.offer_claim_observed.v1'
const id = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[^\s\u0000-\u001f]+$/)
const journeyId = z.string().min(1).max(500)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.string().refine((value) => {
	const at = new Date(value)
	return Number.isFinite(at.getTime()) && at.toISOString() === value
}, 'Expected canonical millisecond UTC instant')

// Successful EMAIL TOKEN LOGIN, not proof of mailbox delivery. Operator-minted
// tokens are trusted by existing auth. Only a future trusted producer may write.
export const emailTokenLoginObservedSchema = z
	.object({
		version: z.literal(1),
		userId: id,
		contactId: id,
		emailFingerprint: hash,
		verifiedAt: instant,
		sessionTokenHash: hash,
		tokenHash: hash,
		mechanism: z.literal('auth-email-callback'),
		observedAt: instant,
	})
	.strict()
export const offerClaimObservedSchema = z
	.object({
		version: z.literal(1),
		journeyId,
		contactId: id,
		verifiedUserId: id,
		attestationEventId: id,
		sessionTokenHash: hash,
		emailFingerprint: hash,
		verifiedAt: instant,
		observedAt: instant,
	})
	.strict()
export type EmailTokenLoginObservedPayload = z.infer<
	typeof emailTokenLoginObservedSchema
>
export type OfferClaimObservedPayload = z.infer<typeof offerClaimObservedSchema>

import { normalizeEmail } from '../contact-email-equivalence'

function keyed(secret: string, domain: string, value: string): string {
	if (!secret || !value) throw new Error('Missing fingerprint input')
	return createHmac('sha256', secret)
		.update(JSON.stringify([domain, value]))
		.digest('hex')
}
export const emailFingerprint = (secret: string, email: string) =>
	keyed(secret, 'aih:owner-proof:email:v1', normalizeEmail(email))
export const sessionTokenHash = (secret: string, token: string) =>
	keyed(secret, 'aih:owner-proof:session:v1', token)
export const emailTokenHash = (secret: string, token: string) =>
	keyed(secret, 'aih:owner-proof:email-token:v1', token)
const key = (kind: string, tuple: readonly string[]) =>
	`owner-proof:${kind}:v1:${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`
// One immutable attestation per accepted token + contact. A repeated callback
// may mint a different session, but must NOT overwrite the original evidence.
export const loginSemanticKey = (
	input: Pick<EmailTokenLoginObservedPayload, 'contactId' | 'tokenHash'>,
) => key('login', [id.parse(input.contactId), hash.parse(input.tokenHash)])
export const claimSemanticKey = (
	input: Pick<
		OfferClaimObservedPayload,
		'journeyId' | 'verifiedUserId' | 'attestationEventId'
	>,
) =>
	key('claim', [
		journeyId.parse(input.journeyId),
		id.parse(input.verifiedUserId),
		id.parse(input.attestationEventId),
	])
export const claimSourceReference = (eventId: string) =>
	`contact-event:${id.parse(eventId)}`
export function claimEventIdFromReference(reference: string): string | null {
	if (!reference.startsWith('contact-event:')) return null
	const parsed = id.safeParse(reference.slice('contact-event:'.length))
	return parsed.success ? parsed.data : null
}

// A future producer must perform a bounded CURRENT uniqueness/provenance lookup
// under its defined transaction before writing. This pure result is a producer
// precondition, NOT production proof because a caller or fixture asserts it.
// Multiple matches are HOLD, never fanout/first-match or a ContactLink shortcut.
export function resolveOwnerContact(
	contactIds: readonly string[],
	expected: string,
) {
	return contactIds.length === 1 && contactIds[0] === expected
		? { type: 'Resolved' as const, contactId: id.parse(expected) }
		: { type: 'Held' as const, reason: 'MissingOrAmbiguousContact' as const }
}
export type OwnerProviderIdentity = Readonly<{
	id: string
	contactId: string
	provider: 'kit'
	externalId: string
}>
export function ownerIdentityEvidence(identity: OwnerProviderIdentity) {
	return {
		source: 'ai-hero' as const,
		strength: 'strong' as const,
		providerIdentity: {
			provider: 'kit' as const,
			externalId: id.parse(identity.externalId),
		},
	}
}
type OwnerContactResolution = ReturnType<typeof resolveOwnerContact>
function row(input: {
	resolution: OwnerContactResolution
	id: string
	identity: OwnerProviderIdentity
	contactId: string
	eventType: typeof EMAIL_TOKEN_LOGIN_OBSERVED | typeof OFFER_CLAIM_OBSERVED
	semanticKey: string
	payload: EmailTokenLoginObservedPayload | OfferClaimObservedPayload
}) {
	if (
		input.resolution.type !== 'Resolved' ||
		input.resolution.contactId !== input.contactId
	)
		throw new Error('Owner contact resolution held')
	if (
		input.identity.contactId !== input.contactId ||
		input.identity.provider !== 'kit'
	)
		throw new Error('Owner identity mismatch')
	return {
		id: id.parse(input.id),
		contactId: id.parse(input.contactId),
		providerIdentityId: id.parse(input.identity.id),
		provider: 'ai-hero',
		providerEventId: input.semanticKey,
		providerReference: `ai-hero:${input.semanticKey}`,
		eventType: input.eventType,
		semanticIdempotencyKey: input.semanticKey,
		privacyLevel: 'restricted',
		identityEvidence: ownerIdentityEvidence(input.identity),
		payloadSummary: input.payload,
		schemaVersion: 1,
		// ContactEvent SQL timestamp is second precision; payload preserves ms.
		occurredAt: new Date(
			Math.floor(Date.parse(input.payload.observedAt) / 1000) * 1000,
		),
	} satisfies typeof contactEvent.$inferInsert
}
export function emailTokenLoginEventRow(input: {
	resolution: OwnerContactResolution
	id: string
	identity: OwnerProviderIdentity
	payload: EmailTokenLoginObservedPayload
}) {
	const payload = emailTokenLoginObservedSchema.parse(input.payload)
	return row({
		...input,
		payload,
		contactId: payload.contactId,
		eventType: EMAIL_TOKEN_LOGIN_OBSERVED,
		semanticKey: loginSemanticKey(payload),
	})
}
export function offerClaimEventRow(input: {
	resolution: OwnerContactResolution
	id: string
	identity: OwnerProviderIdentity
	payload: OfferClaimObservedPayload
}) {
	const payload = offerClaimObservedSchema.parse(input.payload)
	return row({
		...input,
		payload,
		contactId: payload.contactId,
		eventType: OFFER_CLAIM_OBSERVED,
		semanticKey: claimSemanticKey(payload),
	})
}
