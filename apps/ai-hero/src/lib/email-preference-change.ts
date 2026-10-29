import type { AppEmailPreferenceDefinition } from '@/coursebuilder/email-preferences'
import type { EmailPreferenceChangeRequested } from '@/inngest/events/email-preference-change'

import type { PreferenceLinkVerification } from './email-preferences-local'

type ChangeData = EmailPreferenceChangeRequested['data']

export type AcceptedPreferenceChange =
	| { status: 'accepted'; verified: boolean }
	| {
			status: 'rejected'
			reason: 'invalid-link' | 'unverified-opt-in'
	  }

/**
 * The page side of a preference change, with Kit out of the request path.
 *
 * An opt-out always lands: a verified one writes the local row now, and an
 * unverifiable one (unknown Kit id, directory down) is queued for the
 * function to verify. An opt-in needs a verified link. A tampered link is
 * rejected. Only a failure to queue throws, so the reader sees an error and
 * can retry instead of a false "done".
 */
export async function acceptEmailPreferenceChange(
	args: {
		verification: PreferenceLinkVerification
		subscriberId: string
		shKit: string
		preference: AppEmailPreferenceDefinition
		subscribed: boolean
		source: ChangeData['source']
	},
	deps: {
		syncLocal: (args: {
			email: string
			preference: AppEmailPreferenceDefinition
			subscribed: boolean
		}) => Promise<unknown>
		queue: (data: ChangeData) => Promise<unknown>
		onLocalSyncFailed?: (error: unknown) => Promise<void> | void
		now?: () => Date
	},
): Promise<AcceptedPreferenceChange> {
	const { verification } = args
	if (verification.status === 'invalid') {
		return { status: 'rejected', reason: 'invalid-link' }
	}
	if (verification.status === 'unverifiable' && args.subscribed) {
		return { status: 'rejected', reason: 'unverified-opt-in' }
	}

	const base: ChangeData = {
		kitSubscriberId: args.subscriberId,
		shKit: args.shKit,
		preferenceKey: args.preference.key,
		subscribed: args.subscribed,
		source: args.source,
		requestedAt: (deps.now?.() ?? new Date()).toISOString(),
	}

	if (verification.status === 'unverifiable') {
		await deps.queue(base)
		return { status: 'accepted', verified: false }
	}

	const email = verification.subscriber.email_address
	let localSynced = false
	try {
		await deps.syncLocal({
			email,
			preference: args.preference,
			subscribed: args.subscribed,
		})
		localSynced = true
	} catch (error) {
		// The function retries the row; the change itself is still queued.
		await deps.onLocalSyncFailed?.(error)
	}

	await deps.queue({ ...base, email, localSynced })
	return { status: 'accepted', verified: true }
}

export type AppliedPreferenceChange =
	| { status: 'applied'; verifiedBy: 'page' | 'directory' | 'kit' }
	| {
			status: 'dropped'
			reason: 'invalid-link' | 'unverified-opt-in' | 'unknown-subscriber'
	  }

/**
 * The function side: verify if the page could not, then mirror locally,
 * record the opt-out (ContactEvent, which carries the stop to drovr), and
 * write Kit's preference. Each dependency is an Inngest step in production,
 * so a throw retries only the step that failed.
 *
 * `verifyWithKit` answers only for Kit ids the directory does not hold yet
 * (the Kit-only people before the directory import). It runs here, never on
 * a page, and retires with the Kit preference write.
 */
export async function applyEmailPreferenceChange(
	data: ChangeData,
	deps: {
		verify: () => Promise<PreferenceLinkVerification>
		verifyWithKit: () => Promise<string | null>
		syncLocal: (email: string) => Promise<unknown>
		recordOptOut: (email: string) => Promise<unknown>
		writeKit: (email: string) => Promise<unknown>
	},
): Promise<AppliedPreferenceChange> {
	let email = data.email
	let verifiedBy: 'page' | 'directory' | 'kit' = 'page'

	if (!email) {
		if (data.subscribed)
			return { status: 'dropped', reason: 'unverified-opt-in' }
		const verification = await deps.verify()
		if (verification.status === 'invalid') {
			return { status: 'dropped', reason: 'invalid-link' }
		}
		if (verification.status === 'verified') {
			email = verification.subscriber.email_address
			verifiedBy = 'directory'
		} else if (verification.reason === 'directory-unavailable') {
			// Retried by Inngest: never read an outage as a bad link.
			throw new Error('Contact directory unavailable for preference change')
		} else {
			const kitEmail = await deps.verifyWithKit()
			if (!kitEmail) return { status: 'dropped', reason: 'unknown-subscriber' }
			email = kitEmail
			verifiedBy = 'kit'
		}
	}

	if (!data.localSynced) await deps.syncLocal(email)
	if (!data.subscribed) await deps.recordOptOut(email)
	await deps.writeKit(email)
	return { status: 'applied', verifiedBy }
}
