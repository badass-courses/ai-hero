import {
	CONTACT_EVENT_SCHEMA_VERSION,
	type FixtureContactEventInput,
	type NormalizedContactEvent,
} from './types'

const normalizeEmail = (email?: string) => email?.trim().toLowerCase()

const summarize = (
	message: string,
	privacyLevel: FixtureContactEventInput['privacyLevel'],
) => {
	if (privacyLevel === 'restricted') {
		return {
			summary:
				'Restricted provider payload present; raw text withheld from subscriber marketing output.',
			keywords: ['restricted-payload'],
			restrictedPayloadStored: false as const,
		}
	}

	const words = message.toLowerCase().match(/[a-z0-9-]+/g) ?? []
	const keywords = Array.from(
		new Set(words.filter((word) => word.length > 3)),
	).slice(0, 12)
	return {
		summary: keywords.length
			? `Keyword summary: ${keywords.join(', ')}`
			: 'No durable message summary available.',
		keywords,
		restrictedPayloadStored: false as const,
	}
}

export function normalizeContactEvent(
	input: FixtureContactEventInput,
): NormalizedContactEvent {
	const email = normalizeEmail(input.email)
	const externalId = input.externalId ?? email ?? input.providerEventId
	const providerReference = `${input.provider}:${input.providerEventId}`
	const semanticIdempotencyKey = [
		input.provider,
		input.eventType,
		externalId,
		input.providerEventId,
	]
		.join(':')
		.toLowerCase()

	return {
		provider: input.provider,
		providerEventId: input.providerEventId,
		providerReference,
		eventType: input.eventType,
		occurredAt: input.occurredAt,
		semanticIdempotencyKey,
		privacyLevel: input.privacyLevel ?? 'internal',
		identityEvidence: {
			email,
			name: input.name?.trim(),
			userId: input.userId,
			providerIdentity: { provider: input.provider, externalId },
			source: input.provider,
			strength:
				input.userId || input.externalId ? 'strong' : email ? 'medium' : 'weak',
		},
		payloadSummary: summarize(input.message, input.privacyLevel),
		schemaVersion: CONTACT_EVENT_SCHEMA_VERSION,
	}
}
