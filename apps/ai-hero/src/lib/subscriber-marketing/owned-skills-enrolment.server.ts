import 'server-only'

import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { SKILLS_NEWSLETTER_SUBSCRIBED_EVENT } from '@/inngest/events/skills-newsletter'
import { readGatedAskForEmail } from '@/lib/gated-asks-off-kit'
import { hasConfirmedSkillsConsent } from './owned-skills-enrolment'
import { requestDrovrDoiSignup } from './drovr-doi-signup.server'
import type { OptInAttribution } from './opt-in-attribution'
import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'

export function enrolmentOffKitEnabled() {
	return env.AIH_ENROLMENT_OFF_KIT_ENABLED === 'true'
}

/** Called only after the server verified the signed-in address. */
export async function requestOwnedSkillsEnrolment(args: {
	email: string
	name?: string
	source: string
	page: string
	optInAttribution?: OptInAttribution
	deadlineTimeZone?: DeadlineTimeZoneEvidence
}) {
	const evidence = await readGatedAskForEmail(args.email).catch(() => ({
		list: null,
	}))
	const list = evidence.list
	// A profile or an unrelated form is not Skills consent. A returning
	// unsubscribe is never lifted here; only drovr's confirmation can lift it.
	if (!list?.contactId || !hasConfirmedSkillsConsent(list)) {
		if (
			list?.stops.some(
				(stop) => stop.scope === 'all' && stop.reason !== 'unsubscribed',
			)
		) {
			return { success: false as const, reason: 'request-failed' as const }
		}
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
	await inngest.send({
		name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
		data: {
			contactId: list.contactId,
			email: args.email,
			name: args.name,
			formId: 9376133,
			source: args.source,
			subscribedAt: new Date().toISOString(),
			optInAttribution: args.optInAttribution,
			deadlineTimeZone: args.deadlineTimeZone,
		},
	})
	return { success: true as const }
}
