import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'
import { parseDrovrProfileSyncConfig } from './drovr-contact-profile-sync-requests'

export type ProfileRestatementStore = {
	listDue(args: {
		before: string
		after?: string
		limit?: number
	}): Promise<string[]>
	readCursor(): Promise<string | undefined>
	writeCursor(after: string | undefined): Promise<void>
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
	// Each contact's sync posts its own drovr batch, so a group of 100 hit
	// drovr as ~100 simultaneous calls and saturated its database pool
	// (2026-11-14). Ten every 12 seconds keeps the same ~50 a minute, evenly.
	const batchSize = args.batchSize ?? 10
	const pause = args.pause ?? '12s'
	if (!Number.isSafeInteger(batchSize) || batchSize < 1)
		throw new Error('profile restatement batch size must be a positive integer')
	const before = new Date(
		Date.parse(args.startedAt) - 7 * 86400000,
	).toISOString()
	const limit = args.limit ?? 1500
	// A memoized undefined comes back as null.
	const after =
		((await args.step.run('read-cursor', () => args.store.readCursor())) as
			| string
			| null
			| undefined) ?? undefined
	const contactIds = (await args.step.run('due-profiles', () =>
		args.store.listDue({ before, after, limit }),
	)) as string[]
	// A short page ends the lap: the next run starts from the top. Skipped
	// contacts never re-acknowledge, so only the cursor guarantees progress.
	const next = contactIds.length < limit ? undefined : contactIds.at(-1)
	await args.step.run('write-cursor', () => args.store.writeCursor(next))
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
	return {
		status: 'queued' as const,
		contacts: contactIds.length,
		lapEnded: next === undefined,
	}
}
