import { DROVR_CONTACT_SYNC_BACKFILL_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import { createDrizzleBackfillApprovals } from '@/lib/subscriber-marketing/contact-sync-backfill-approval'
import { persistContactSyncBulk } from '@/lib/subscriber-marketing/contact-sync-bulk'
import { captureDrovrOutboxLive } from '@/lib/subscriber-marketing/drovr-outbox-live'
import { profileVersionForRefresh } from '@/lib/subscriber-marketing/contact-sync-offer-refresh'
import { runContactSyncBackfill } from '@/lib/subscriber-marketing/contact-sync-backfill'

/**
 * Contact sync, PR 4: the one-time backfill. Nothing schedules it: it runs
 * only when an operator sends `drovr/contact-sync.backfill-requested` (on
 * the hawk's go), counts first, then requires a one-contact canary. Every
 * continuation is another approved command; no run re-queues itself. Behind
 * AIH_DROVR_PROFILE_SYNC like the rest of contact sync.
 */
export const drovrContactSyncBackfill = inngest.createFunction(
	{
		id: 'drovr-contact-sync-backfill-v1',
		name: 'drovr: contact sync backfill',
		retries: 4,
		// One cursor: a second run would walk the same pages.
		concurrency: [{ limit: 1 }],
	},
	{ event: DROVR_CONTACT_SYNC_BACKFILL_EVENT },
	async ({ event, step }) => {
		const [
			{ db },
			{ env },
			{ log },
			{ DrizzleCaptureMarketingRepository },
			{ createDrizzleValuePathLinkAnchorStore },
			{ createDrizzleContactProfileVersionStore },
			{ findContactKitIdentity },
			{ readContactProfileSnapshot },
			{ getValuePathAnswerPages },
			{ DROVR_SKILLS_COURSE_JOURNEY_ID },
			{ findJourneyOwnerAssignment },
			{ SKILLS_WORKFLOW_VALUE_PATH },
			{ stopFactsFor },
			{ createDrizzleBackfillScan, createDrizzleBackfillCount },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/server/logger'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('@/lib/subscriber-marketing/drizzle-value-path-link-anchor'),
			import('@/lib/subscriber-marketing/contact-profile-version-drizzle'),
			import('@/lib/subscriber-marketing/contact-kit-identity-drizzle'),
			import('@/lib/subscriber-marketing/drovr-contact-profile-sync'),
			import('@/lib/subscriber-marketing/value-path-answer-page'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
			import('@/lib/subscriber-marketing/drovr-ownership'),
			import('@/lib/subscriber-marketing/skills-newsletter-path-entry'),
			import('@/lib/subscriber-marketing/contact-sync-reconcile'),
			import('@/lib/subscriber-marketing/contact-sync-backfill-drizzle'),
		])
		const repository = new DrizzleCaptureMarketingRepository(db)
		const versions = createDrizzleContactProfileVersionStore(db)
		const linkAnchors = createDrizzleValuePathLinkAnchorStore(db)
		return runContactSyncBackfill({
			event,
			step,
			env: process.env,
			ports: {
				now: () => Date.now(),
				scanEvents: createDrizzleBackfillScan(db),
				countEvents: createDrizzleBackfillCount(db),
				approvals: createDrizzleBackfillApprovals(db),
				snapshot: async (contactId, now) => {
					const owned = await findJourneyOwnerAssignment(
						repository,
						contactId,
						DROVR_SKILLS_COURSE_JOURNEY_ID,
					)
					const valuePathSlug = owned ? SKILLS_WORKFLOW_VALUE_PATH : undefined
					return readContactProfileSnapshot({
						repository,
						contactId,
						kitIdentity: await findContactKitIdentity(db, contactId),
						valuePathSlug,
						answerPages: valuePathSlug ? await getValuePathAnswerPages() : [],
						baseUrl:
							env.NEXT_PUBLIC_URL ??
							env.NEXT_PUBLIC_SITE_URL ??
							'https://www.aihero.dev',
						pathTokenSecret: env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
						linkAnchors,
						now,
						warn: log.warn,
					})
				},
				versionFor: (contactId, contentHash, legacyHash) =>
					versions.versionFor(contactId, contentHash, legacyHash),
				persistEvents: async events => {
					await persistContactSyncBulk(events, captureDrovrOutboxLive, 'bulkBackfill')
					for (const profile of events.filter(item => item.type === 'contact.profile.updated')) {
						const version = profileVersionForRefresh(profile)
						const current = await versions.currentFor(profile.contactId)
						// Do not postpone the confirmation of an already-queued version.
						if (current?.profileVersion === version && !current.acknowledged) await versions.acknowledge(profile.contactId, version)
					}
				},
				liveStopFacts: (rows) => stopFactsFor(repository, rows),
			},
		})
	},
)
