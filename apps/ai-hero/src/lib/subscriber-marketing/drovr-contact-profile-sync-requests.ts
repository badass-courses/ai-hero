import {
	DROVR_CONTACT_PROFILE_SYNC_EVENT,
	type DrovrContactProfileSyncRequested,
} from '@/inngest/events/drovr'

import type { CouponIssueResult } from './drovr-evergreen-coupon'

/**
 * Asking for a contact-profile sync, kept a leaf: its only runtime import is
 * the event name. The skills entry imports this, and drovr-evergreen reads
 * the entry's constants at load, so pulling the whole sync module
 * (personalize, the executor, drovr-evergreen) in here closed a cycle that
 * crashed the production build (#311, "Cannot access before
 * initialization"). Keep it free of runtime imports from subscriber-marketing.
 */

export type DrovrProfileSyncConfig =
	| { enabled: true }
	| { enabled: false; reason: string }

export function parseDrovrProfileSyncConfig(
	env: Readonly<Record<string, string | number | undefined>>,
): DrovrProfileSyncConfig {
	const flag = String(env.AIH_DROVR_PROFILE_SYNC ?? '')
		.trim()
		.toLowerCase()
	if (flag !== 'true' && flag !== '1') {
		return { enabled: false, reason: 'AIH_DROVR_PROFILE_SYNC is not set' }
	}
	return { enabled: true }
}

type ProfileSyncRequest = DrovrContactProfileSyncRequested['data']

/**
 * Ask for one contact's profile sync, off the host's path: a no-op while
 * the flag is off, and a failed send never reaches the caller. A lost
 * request is repaired by the ContactEvent reconcile.
 */
export function requestContactProfileSyncSafely(
	request: ProfileSyncRequest,
	options: {
		env?: Readonly<Record<string, string | number | undefined>>
		send?: (event: DrovrContactProfileSyncRequested) => unknown
	} = {},
): void {
	try {
		if (!parseDrovrProfileSyncConfig(options.env ?? process.env).enabled) return
		const send = options.send ?? sendWithInngest
		void Promise.resolve(
			send({ name: DROVR_CONTACT_PROFILE_SYNC_EVENT, data: request }),
		).catch(() => undefined)
	} catch {
		// A profile sync request must never escape into the host flow.
	}
}

/**
 * The awaited request, for a writer that changes a profile input without a
 * ContactEvent the reconcile scans: its sync must not be silently lost, so a
 * failed send is logged at error (the reconcile's watermark would otherwise
 * over-claim). Still never throws into the host flow.
 */
export async function requestContactProfileSync(
	request: ProfileSyncRequest,
	options: {
		env?: Readonly<Record<string, string | number | undefined>>
		send?: (event: DrovrContactProfileSyncRequested) => unknown
		error?: (event: string, fields: Record<string, unknown>) => unknown
	} = {},
): Promise<'requested' | 'off' | 'failed'> {
	if (!parseDrovrProfileSyncConfig(options.env ?? process.env).enabled)
		return 'off'
	try {
		await (options.send ?? sendWithInngest)({
			name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
			data: request,
		})
		return 'requested'
	} catch (failure) {
		try {
			const error = options.error ?? (await import('@/server/logger')).log.error
			await error('drovr.profile_sync.request_failed', {
				contactId: request.contactId,
				reason: request.reason,
				error: failure instanceof Error ? failure.message : String(failure),
			})
		} catch {
			// Logging cannot make the request land.
		}
		return 'failed'
	}
}

async function sendWithInngest(event: DrovrContactProfileSyncRequested) {
	const { inngest } = await import('@/inngest/inngest.server')
	return inngest.send(event)
}

/**
 * One offer sync per coupon a sender run issued. The sender sends these as
 * a durable step: a coupon is not a ContactEvent, so the reconcile would
 * never repair a lost request.
 */
export function offerProfileSyncRequests(
	results: readonly CouponIssueResult[],
	config: DrovrProfileSyncConfig,
): DrovrContactProfileSyncRequested[] {
	if (!config.enabled) return []
	return results.flatMap((result) =>
		result.status === 'completed'
			? [
					{
						name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
						data: { contactId: result.contactId, reason: 'offer-issued' },
					},
				]
			: [],
	)
}
