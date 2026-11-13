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
		sleep(id: string, time: string | number): Promise<unknown>
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
	batchSize?: number
	pause?: string | number
}) {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled)
		return { status: 'skipped' as const, reason: config.reason }
	if (!args.configured)
		return { status: 'skipped' as const, reason: 'drovr-not-configured' }
	const batchSize = args.batchSize ?? 100
	const pause = args.pause ?? '2m'
	if (!Number.isSafeInteger(batchSize) || batchSize < 1)
		throw new Error('profile restatement batch size must be a positive integer')
	const before = new Date(
		Date.parse(args.startedAt) - 7 * 86400000,
	).toISOString()
	const contactIds = (await args.step.run('due-profiles', () =>
		args.store.listDue({ before, limit: args.limit ?? 1500 }),
	)) as string[]
	// Durable pauses spread profile reads across batches. Child runs retain
	// per-contact concurrency; the parent stays well below the step limit.
	for (let offset = 0; offset < contactIds.length; offset += batchSize) {
		const batch = offset / batchSize
		await args.step.sendEvent(
			`restate-batch-${batch}`,
			contactIds.slice(offset, offset + batchSize).map((contactId) => ({
				id: `drovr-profile-restatement:${args.startedAt}:${contactId}`,
				name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
				data: { contactId, reason: 'reconcile' },
			})),
		)
		if (offset + batchSize < contactIds.length)
			await args.step.sleep(`restate-pace-${batch}`, pause)
	}
	return { status: 'queued' as const, contacts: contactIds.length }
}
