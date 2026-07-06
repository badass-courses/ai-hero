'use server'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { log } from '@/server/logger'

import { cohortWaitlistTagName } from './cohort-interest-config'

/**
 * Apply the per-cohort waitlist Kit tag (waitlist_<product>) to a subscriber by
 * email. The subscribe form sets the matching custom field but can't apply a
 * tag, so this closes that gap — waitlist signups end up both fielded and
 * tagged, mirroring the workshop interest path. Best-effort: failures are
 * logged but never thrown, so tagging can't break the signup just completed.
 */
export async function tagCohortWaitlistByEmail(
	email: string,
	productName: string,
) {
	if (!email || !productName) {
		return { success: false as const, reason: 'missing-input' as const }
	}

	const tagName = cohortWaitlistTagName(productName)
	try {
		// The provider resolves the tag name to an id (creating the tag on first
		// use) and applies it. tagSubscriber is optional on the interface, but the
		// ConvertKit provider always defines it.
		await emailListProvider.tagSubscriber?.({ tag: tagName, email })
		return { success: true as const }
	} catch (error) {
		await log.error('cohort.waitlist.tag.failed', {
			productName,
			tagName,
			error: error instanceof Error ? error.message : String(error),
		})
		return { success: false as const, reason: 'request-failed' as const }
	}
}
