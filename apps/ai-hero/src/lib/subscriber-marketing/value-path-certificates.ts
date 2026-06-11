import { db } from '@/db'
import { contact, providerIdentity, sideEffectIntent } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

export const SKILLS_WORKFLOW_CERTIFICATE_RESOURCE =
	'value-path:ai-hero-skills-workflow'

export type ValuePathCertificateEligibility = {
	eligible: boolean
	resourceIdOrSlug: typeof SKILLS_WORKFLOW_CERTIFICATE_RESOURCE
	contactId?: string
	learnerName?: string | null
	learnerEmail?: string | null
	completedAt?: Date | null
	reason?: string
}

export async function checkSkillsWorkflowValuePathCertificateEligibility(input: {
	contactId?: string | null
	kitSubscriberId?: string | number | null
	email?: string | null
}): Promise<ValuePathCertificateEligibility> {
	const resolvedContact = await findValuePathCertificateContact(input)
	if (!resolvedContact) {
		return {
			eligible: false,
			resourceIdOrSlug: SKILLS_WORKFLOW_CERTIFICATE_RESOURCE,
			reason: 'contact-not-found',
		}
	}

	// Drizzle's typed query API is awkward for portable nested JSON matching here.
	// This is bounded to one contact and completed value-path email intents.
	const completedIntents = await db.query.sideEffectIntent.findMany({
		where: and(
			eq(sideEffectIntent.contactId, resolvedContact.id),
			eq(sideEffectIntent.type, 'send-value-path-email'),
			eq(sideEffectIntent.status, 'completed'),
		),
	})
	const completedTerminalIntent = completedIntents.find(
		(intent) =>
			intent.metadata?.emailResourceId === 'ai-hero-skills-workflow.email-6' ||
			intent.metadata?.emailResourceId ===
				'ai-hero-skills-team-workflow.team-email-6',
	)

	if (!completedTerminalIntent) {
		return {
			eligible: false,
			resourceIdOrSlug: SKILLS_WORKFLOW_CERTIFICATE_RESOURCE,
			contactId: resolvedContact.id,
			learnerName: resolvedContact.name,
			learnerEmail: resolvedContact.email,
			reason: 'value-path-not-complete',
		}
	}

	return {
		eligible: true,
		resourceIdOrSlug: SKILLS_WORKFLOW_CERTIFICATE_RESOURCE,
		contactId: resolvedContact.id,
		learnerName: resolvedContact.name,
		learnerEmail: resolvedContact.email,
		completedAt: completedTerminalIntent.createdAt,
	}
}

export function isSkillsWorkflowCertificateResource(resourceIdOrSlug: string) {
	return resourceIdOrSlug === SKILLS_WORKFLOW_CERTIFICATE_RESOURCE
}

async function findValuePathCertificateContact(input: {
	contactId?: string | null
	kitSubscriberId?: string | number | null
	email?: string | null
}) {
	if (input.contactId) {
		const byContactId = await db.query.contact.findFirst({
			where: eq(contact.id, input.contactId),
		})
		if (byContactId) return byContactId
	}

	if (input.kitSubscriberId) {
		const identity = await db.query.providerIdentity.findFirst({
			where: and(
				eq(providerIdentity.provider, 'kit'),
				eq(providerIdentity.externalId, String(input.kitSubscriberId)),
			),
		})
		if (identity) {
			const byIdentity = await db.query.contact.findFirst({
				where: eq(contact.id, identity.contactId),
			})
			if (byIdentity) return byIdentity
		}
	}

	if (input.email) {
		return db.query.contact.findFirst({
			where: eq(contact.email, input.email.toLowerCase()),
		})
	}

	return null
}
