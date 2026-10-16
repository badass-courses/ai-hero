import { inngest } from '@/inngest/inngest.server'
import { drovrContactProfileSync } from './drovr-contact-profile-sync'
import { parseDrovrProfileSyncConfig } from '@/lib/subscriber-marketing/drovr-contact-profile-sync-requests'
import type { ContactProfileSyncReceipt } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'
import { dueProfileConfirmations } from '@/lib/subscriber-marketing/contact-sync-restatement'

/** A separate quota, never the heartbeat clock. Capacity produces a structured
 * alert and terminal run failure; routing that alert to a pager is follow-up.
 */
export const drovrContactSyncRestate = inngest.createFunction(
	{
		id: 'drovr-contact-sync-restate-v1',
		name: 'drovr: slowly confirm stored profiles',
		retries: 3,
		concurrency: [{ limit: 1 }],
	},
	{ cron: '7-52/15 * * * *' },
	async ({ step }) => {
		if (!parseDrovrProfileSyncConfig(process.env).enabled)
			return { status: 'skipped' }
		const contacts = await step.run(
			'acknowledged-oldest-due-profiles',
			async () => {
				const [{ db }, { log }] = await Promise.all([
					import('@/db'),
					import('@/server/logger'),
				])
				return dueProfileConfirmations(db, Date.now(), (fields) =>
					log.error('drovr.restate.capacity_exceeded', fields),
				)
			},
		)
		for (const { contactId } of contacts) {
			const receipt = (await step.invoke(`restate:${contactId}`, {
				function: drovrContactProfileSync,
				data: { contactId, reason: 'restate' },
			})) as ContactProfileSyncReceipt
			// Migration sent nothing. Leave it due, so the next tick can confirm v2.
			if (receipt.status === 'skipped' && (receipt.reason === 'hash-migrated' || receipt.reason === 'period-already-confirmed'))
				continue
			if (receipt.status === 'skipped') {
				if (
					![
						'no-sending-journey',
						'contact-missing',
						'synthetic-principal',
						'contact-email-missing',
						'profile-not-issued',
					].includes(receipt.reason)
				)
					throw new Error(
						'RestatementDelivery: you requested a confirmation, and it failed because the profile was not queued. Accepted: a delivered or durably queued confirmation, or a contact outside directory scope. Fix: restore delivery before advancing this rotation. Debug: inspect the contact sync receipt.',
					)
				// A scope skip is not receiver proof. Only the child ACK effect
				// owns this clock. Selection fairness is a separate concern; never
				// hide it by fabricating confirmation age or a delivered receipt.
				continue
			}
		}
		return { status: 'queued', contacts: contacts.length }
	},
)
