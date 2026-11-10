import { db } from '@/db'
import { contact, providerIdentity, sideEffectIntent } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

import {
	readDrovrCertificateCompletion,
	type DrovrCertificateCompletion,
} from './drovr-certificate-completion'
import { valuePathIntentCompletedAt } from './value-path-completion'

export const SKILLS_WORKFLOW_CERTIFICATE_RESOURCE =
	'value-path:ai-hero-skills-workflow'

export function buildSkillsWorkflowValuePathCertificateUrl(input: {
	contactId: string
	baseUrl?: string
}) {
	const path = '/api/certificates'
	const params = new URLSearchParams({
		resource: SKILLS_WORKFLOW_CERTIFICATE_RESOURCE,
		user: input.contactId,
	})
	return input.baseUrl
		? new URL(`${path}?${params}`, input.baseUrl).toString()
		: `${path}?${params}`
}

export type ValuePathCertificateEligibility = {
	eligible: boolean
	resourceIdOrSlug: typeof SKILLS_WORKFLOW_CERTIFICATE_RESOURCE
	contactId?: string
	learnerName?: string | null
	learnerEmail?: string | null
	completedAt?: Date | null
	reason?:
		| 'contact-not-found'
		| 'value-path-not-complete'
		| 'completion-evidence-unavailable'
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

	// This is bounded to one contact. Completion is decided by the canonical
	// fact helper, with the legacy metadata fallback only for the cutover window.
	const pathIntents = await db.query.sideEffectIntent.findMany({
		where: and(
			eq(sideEffectIntent.contactId, resolvedContact.id),
			eq(sideEffectIntent.type, 'send-value-path-email'),
		),
	})
	const completedTerminalIntent = pathIntents.find(
		(intent) =>
			intent.status === 'completed' &&
			valuePathIntentCompletedAt(intent) &&
			new Date(valuePathIntentCompletedAt(intent)!).getTime() <= Date.now() &&
			(intent.metadata?.emailResourceId === 'ai-hero-skills-workflow.email-6' ||
				intent.metadata?.emailResourceId ===
					'ai-hero-skills-team-workflow.team-email-6'),
	)

	const learner = {
		resourceIdOrSlug: SKILLS_WORKFLOW_CERTIFICATE_RESOURCE,
		contactId: resolvedContact.id,
		learnerName: resolvedContact.name || resolvedContact.email,
		learnerEmail: resolvedContact.email,
	} as const
	if (completedTerminalIntent) {
		return {
			...learner,
			eligible: true,
			completedAt: new Date(
				valuePathIntentCompletedAt(completedTerminalIntent)!,
			),
		}
	}

	const delivery = await readCertificateLessonDelivery(resolvedContact.id)
	if (delivery.status === 'completed') {
		return { ...learner, eligible: true, completedAt: delivery.completedAt }
	}
	return {
		...learner,
		eligible: false,
		reason:
			delivery.status === 'unavailable'
				? 'completion-evidence-unavailable'
				: 'value-path-not-complete',
	}
}

/**
 * Lesson 7 on either track earns the certificate. The team read runs only
 * when the individual read says not completed, and an unavailable team read
 * leaves that answer standing: unavailable evidence never becomes completion,
 * and drovr's `/email-delivery` may not accept the team id yet.
 */
async function readCertificateLessonDelivery(
	contactId: string,
): Promise<DrovrCertificateCompletion> {
	const individual = await readDrovrCertificateCompletion(
		contactId,
		'ai-hero-skills-workflow.email-6',
	)
	if (individual.status !== 'not-completed') return individual
	const team = await readDrovrCertificateCompletion(
		contactId,
		'ai-hero-skills-team-workflow.team-email-6',
	)
	return team.status === 'completed' ? team : individual
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
