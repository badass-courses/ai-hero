import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'
import { parseDrovrProfileSyncConfig } from './drovr-contact-profile-sync-requests'

export type ProfileRestatementStore = {
	listDue(args: { before: string; limit?: number }): Promise<string[]>
}

/** Daily discovery only; the existing per-contact sync owns delivery and acknowledgement. */
export async function runProfileRestatementSweep(args: {
	env: Readonly<Record<string, string | undefined>>
	configured: boolean
	startedAt: string
	store: ProfileRestatementStore
	step: {
		run<T>(id: string, callback: () => Promise<T>): Promise<unknown>
		sendEvent(
			id: string,
			events: {
				id: string
				name: typeof DROVR_CONTACT_PROFILE_SYNC_EVENT
				data: { contactId: string; reason: 'reconcile' }
			}[],
		): Promise<unknown>
	}
	limit?: number
}) {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled)
		return { status: 'skipped' as const, reason: config.reason }
	if (!args.configured)
		return { status: 'skipped' as const, reason: 'drovr-not-configured' }
	const before = new Date(
		Date.parse(args.startedAt) - 7 * 86400000,
	).toISOString()
	const contactIds = (await args.step.run('due-profiles', () =>
		args.store.listDue({ before, limit: args.limit ?? 1500 }),
	)) as string[]
	// Batches keep this run well below the step limit. Child runs retain the
	// sync function's per-contact concurrency and its acknowledgement throttle.
	for (let offset = 0; offset < contactIds.length; offset += 100) {
		await args.step.sendEvent(
			`restate-batch-${offset / 100}`,
			contactIds.slice(offset, offset + 100).map((contactId) => ({
				id: `drovr-profile-restatement:${args.startedAt}:${contactId}`,
				name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
				data: { contactId, reason: 'reconcile' },
			})),
		)
	}
	return { status: 'queued' as const, contacts: contactIds.length }
}
