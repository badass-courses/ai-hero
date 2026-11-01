import 'server-only'

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { contact } from '@/db/schema'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { SKILLS_NEWSLETTER_SUBSCRIBED_EVENT } from '@/inngest/events/skills-newsletter'
import { getServerAuthSession } from '@/server/auth'
import { resolveOwnedSkillsContact } from './owned-skills-enrolment'
import { readOwnedSkillsAdmission } from './owned-skills-list-state'
import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import { parseDrovrSignupDeliveryConfig } from './drovr-doi-signup'
import { requestDrovrDoiSignup } from './drovr-doi-signup.server'
import type { OptInAttribution } from './opt-in-attribution'
import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'

export function enrolmentOffKitEnabled() {
	return env.AIH_ENROLMENT_OFF_KIT_ENABLED === 'true'
}

/** A verified session plus this explicit click grants course consent, never a stop lift. */
export async function requestOwnedSkillsEnrolment(args: {
	email: string
	name?: string
	source: string
	page: string
	optInAttribution?: OptInAttribution
	deadlineTimeZone?: DeadlineTimeZoneEvidence
}) {
	const auth = await getServerAuthSession()
	const user = auth?.session?.user
	if (
		!user?.email ||
		user.email.trim().toLowerCase() !== args.email.trim().toLowerCase()
	) {
		throw new Error('Owned enrolment requires the matching signed-in address')
	}
	const subscribedAt = new Date().toISOString()
	const contactId = await resolveOwnedSkillsContact({
		repository: new DrizzleCaptureMarketingRepository(db),
		findContactIdsByEmailKey: async (key) =>
			(
				await db
					.select({ id: contact.id })
					.from(contact)
					.where(eq(contact.emailKey, key))
					.limit(2)
			).map((row) => row.id),
		email: args.email,
		name: args.name,
		userId: user.id,
		now: subscribedAt,
	})
	const admission = await readOwnedSkillsAdmission(
		contactId,
		parseDrovrSignupDeliveryConfig(env),
	).catch(() => ({ status: 'unavailable' as const }))
	if (admission.status === 'doi') {
		await requestDrovrDoiSignup({
			email: args.email,
			name: args.name,
			kitFormId: 9376133,
			page: args.page,
			optInAttribution: args.optInAttribution,
			entry: 'tag-me',
		})
		return {
			success: false as const,
			reason: 'confirmation-required' as const,
			confirmationUrl: `/confirm?email=${encodeURIComponent(args.email)}`,
		}
	}
	// Both allowed and unavailable requests are durable. The worker must read
	// stops successfully before enrolment; an unavailable read retries, not DOI.
	let page = '/skills'
	try {
		const url = new URL(args.page)
		page = `${url.origin}${url.pathname}`
	} catch {}
	await inngest.send({
		name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
		data: {
			contactId,
			email: args.email,
			name: args.name,
			signedInUserId: user.id,
			formId: 9376133,
			source: args.source,
			page,
			subscribedAt,
			optInAttribution: args.optInAttribution,
			deadlineTimeZone: args.deadlineTimeZone,
		},
	})
	return { success: true as const }
}
