import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { contact } from '@/db/schema'
import { DROVR_SIGNUP_REQUESTED_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'

import { DrizzleCaptureMarketingRepository } from './drizzle-capture-repository'
import {
	buildDrovrSignupRequest,
	DOI_DROVR_FORM_IDS,
	resolveDoiSignupContact,
} from './drovr-doi-signup'
import type { OptInAttribution } from './opt-in-attribution'

/**
 * One double opt-in signup, for any entry point (the form route, the
 * /skills tag-me action): find or create the contact without Kit, then
 * hand drovr the signup durably. drovr sends the confirmation email and
 * births the course on confirmation. Throws on any failure; callers answer
 * their own error and never fall back to Kit.
 */
export async function requestDrovrDoiSignup(args: {
	email: string
	name?: string
	kitFormId: number
	page: string
	optInAttribution?: OptInAttribution
	/** Which entry point, for the log. */
	entry: 'form' | 'tag-me'
}): Promise<{ contactId: string }> {
	const drovrFormId = DOI_DROVR_FORM_IDS.get(args.kitFormId)
	if (!drovrFormId) {
		throw new Error(
			`Kit form ${args.kitFormId} has no drovr double opt-in form`,
		)
	}
	const now = new Date().toISOString()
	const submissionId = randomUUID()
	const { contactId } = await resolveDoiSignupContact({
		repository: new DrizzleCaptureMarketingRepository(db),
		findContactIdsByEmailKey: async (emailKey) =>
			(
				await db
					.select({ id: contact.id })
					.from(contact)
					.where(eq(contact.emailKey, emailKey))
					.limit(2)
			).map((row) => row.id),
		email: args.email,
		name: args.name,
		drovrFormId,
		optInAttribution: args.optInAttribution,
		now,
	})
	await inngest.send({
		id: `drovr-signup:${submissionId}`,
		name: DROVR_SIGNUP_REQUESTED_EVENT,
		data: buildDrovrSignupRequest({
			contactId,
			drovrFormId,
			occurredAt: now,
			submissionId,
			page: args.page,
		}),
	})
	await log.info('skills.newsletter.doi.requested', {
		formId: args.kitFormId,
		contactId,
		entry: args.entry,
		hasAttribution: Boolean(args.optInAttribution),
	})
	return { contactId }
}
