import type {
	ContactRecord,
	IdentityResolution,
	NormalizedContactEvent,
	ProviderIdentityRecord,
} from './types'

export type IdentityRepository = {
	findProviderIdentity(
		provider: string,
		externalId: string,
	): ProviderIdentityRecord | undefined
	findContactById(id: string): ContactRecord | undefined
	findContactByEmail(email: string): ContactRecord | undefined
	createContact(input: Omit<ContactRecord, 'id'>): ContactRecord
	createProviderIdentity(
		input: Omit<ProviderIdentityRecord, 'id'>,
	): ProviderIdentityRecord
	linkProviderIdentityToContact(
		identityId: string,
		contactId: string,
	): ProviderIdentityRecord
}

export function resolveOrCreateIdentity(args: {
	repository: IdentityRepository
	event: NormalizedContactEvent
	now: string
}): IdentityResolution {
	const evidence = args.event.identityEvidence
	const providerIdentityEvidence = evidence.providerIdentity
	if (!providerIdentityEvidence)
		throw new Error('Normalized event missing provider identity evidence')

	const existingIdentity = args.repository.findProviderIdentity(
		providerIdentityEvidence.provider,
		providerIdentityEvidence.externalId,
	)
	if (existingIdentity) {
		const contact = args.repository.findContactById(existingIdentity.contactId)
		if (!contact)
			throw new Error(
				`Provider identity ${existingIdentity.id} points at missing contact`,
			)
		return {
			contact,
			providerIdentity: existingIdentity,
			createdContact: false,
			createdProviderIdentity: false,
		}
	}

	const contact = args.repository.createContact({
		userId: evidence.userId ?? null,
		email: evidence.email ?? null,
		name: evidence.name ?? null,
		lifecycle: 'new',
		isProvisional: true,
		createdAt: args.now,
		updatedAt: args.now,
	})
	const providerIdentity = args.repository.createProviderIdentity({
		contactId: contact.id,
		provider: providerIdentityEvidence.provider,
		externalId: providerIdentityEvidence.externalId,
		evidence,
		createdAt: args.now,
		updatedAt: args.now,
	})

	return {
		contact,
		providerIdentity,
		createdContact: true,
		createdProviderIdentity: true,
	}
}
