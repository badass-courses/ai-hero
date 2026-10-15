import { inngest } from '@/inngest/inngest.server'
import { drovrContactProfileSync } from './drovr-contact-profile-sync'
import { parseDrovrProfileSyncConfig } from '@/lib/subscriber-marketing/drovr-contact-profile-sync-requests'
import type { ContactProfileSyncReceipt } from '@/lib/subscriber-marketing/drovr-contact-profile-sync'
import { restatementPlan } from '@/lib/subscriber-marketing/contact-sync-deltas'

/** This is not a snapshot or a full re-push. Oldest profiles get one
 * equal-version confirmation each month. The independent delta reconcile
 * still sends its heartbeat every quarter hour, even if this lane stalls.
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
		const contacts = await step.run('oldest-due-profiles', async () => {
			const [
				{ db },
				{ contactProfileVersion },
				{ count, or, isNull, lte, asc },
			] = await Promise.all([
				import('@/db'),
				import('@/db/contact-sync-schema'),
				import('drizzle-orm'),
			])
			const [population] = await db
				.select({ total: count() })
				.from(contactProfileVersion)
			const plan = restatementPlan(Number(population?.total ?? 0), Date.now())
			return db
				.select({ contactId: contactProfileVersion.contactId })
				.from(contactProfileVersion)
				.where(
					or(
						isNull(contactProfileVersion.acknowledgedAt),
						lte(
							contactProfileVersion.acknowledgedAt,
							new Date(plan.before)
								.toISOString()
								.slice(0, 23)
								.replace('T', ' '),
						),
					),
				)
				.orderBy(
					asc(contactProfileVersion.acknowledgedAt),
					asc(contactProfileVersion.contactId),
				)
				.limit(plan.contacts)
		})
		for (const { contactId } of contacts) {
			const receipt = (await step.invoke(`restate:${contactId}`, {
				function: drovrContactProfileSync,
				data: { contactId, reason: 'restate' },
			})) as ContactProfileSyncReceipt
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
						'RestatementDelivery: you requested a confirmation, and it failed because the profile was not queued. Accepted: a delivered or durably queued confirmation, or a contact outside the directory scope. Fix: restore delivery before advancing this rotation. Debug: inspect the contact sync receipt.',
					)
				// Missing/out-of-scope contacts must not monopolize the oldest-first
				// quota. This records an attempt only, never acknowledges a version.
				await step.run(`defer-out-of-scope:${contactId}`, async () => {
					const [{ db }, { contactProfileVersion }, { eq, sql }] =
						await Promise.all([
							import('@/db'),
							import('@/db/contact-sync-schema'),
							import('drizzle-orm'),
						])
					await db
						.update(contactProfileVersion)
						.set({
							acknowledgedAt: sql`CURRENT_TIMESTAMP(3)`,
							updatedAt: sql`${contactProfileVersion.updatedAt}`,
						})
						.where(eq(contactProfileVersion.contactId, contactId))
				})
			}
		}
		return { status: 'queued', contacts: contacts.length }
	},
)
