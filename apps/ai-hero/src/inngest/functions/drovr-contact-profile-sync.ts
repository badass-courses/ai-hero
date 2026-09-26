import {
	DROVR_CONTACT_PROFILE_SYNC_EVENT,
	DROVR_EVENTS_DELIVER_EVENT,
	type DrovrContactProfileSyncRequested,
	type DrovrEventsDeliver,
} from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'
import {
	buildContactProfileEvents,
	parseDrovrProfileSyncConfig,
	type ContactProfileSnapshot,
} from '@/lib/subscriber-marketing/drovr-contact-profile-sync'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

export type ContactProfileSyncReceipt =
	| { status: 'skipped'; reason: string }
	| { status: 'sent'; profileVersion: number; links: number; offers: number }

type SyncStep = {
	run: <T>(id: string, callback: () => Promise<T>) => Promise<unknown>
	sendEvent: (
		id: string,
		event: Pick<DrovrEventsDeliver, 'name' | 'data'>,
	) => Promise<unknown>
}

/**
 * One contact's profile to drovr's contact directory: read it, bump its
 * version once, and hand the events to the live delivery lane
 * (drovr-events-deliver), which posts each under its idempotency key.
 * Events addressed to the authority tenant are no owner fan-out candidates,
 * so no owner read stands in their way. Read before the bump, so a missing
 * contact spends no version; per-contact concurrency of one keeps a higher
 * version carrying newer content.
 */
export async function runContactProfileSync(args: {
	event: Pick<DrovrContactProfileSyncRequested, 'data'>
	step: SyncStep
	env: Readonly<Record<string, string | undefined>>
	readSnapshot: (request: {
		contactId: string
		valuePathSlug?: string
	}) => Promise<ContactProfileSnapshot | undefined>
	bump: (contactId: string) => Promise<number>
}): Promise<ContactProfileSyncReceipt> {
	const config = parseDrovrProfileSyncConfig(args.env)
	if (!config.enabled) return { status: 'skipped', reason: config.reason }
	const { contactId, valuePathSlug } = args.event.data
	if (isSyntheticPrincipalId(contactId)) {
		return { status: 'skipped', reason: 'synthetic-principal' }
	}
	const snapshot = (await args.step.run('read-profile', () =>
		args.readSnapshot({ contactId, valuePathSlug }),
	)) as ContactProfileSnapshot | undefined
	if (!snapshot) return { status: 'skipped', reason: 'contact-missing' }
	const profileVersion = (await args.step.run('bump-profile-version', () =>
		args.bump(contactId),
	)) as number
	const events = buildContactProfileEvents({
		contactId,
		profileVersion,
		...snapshot,
	})
	await args.step.sendEvent('deliver-profile', {
		name: DROVR_EVENTS_DELIVER_EVENT,
		data: { source: 'contact-profile-sync', events },
	})
	return {
		status: 'sent',
		profileVersion,
		links: snapshot.links.length,
		offers: snapshot.offers.length,
	}
}

export const drovrContactProfileSync = inngest.createFunction(
	{
		id: 'drovr-contact-profile-sync-v1',
		name: 'drovr: sync one contact profile',
		retries: 6,
		concurrency: [{ key: 'event.data.contactId', limit: 1 }],
	},
	{ event: DROVR_CONTACT_PROFILE_SYNC_EVENT },
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
		])
		return runContactProfileSync({
			event,
			step,
			env: process.env,
			readSnapshot: async ({ contactId, valuePathSlug }) =>
				readContactProfileSnapshot({
					repository: new DrizzleCaptureMarketingRepository(db),
					contactId,
					kitIdentity: await findContactKitIdentity(db, contactId),
					valuePathSlug,
					answerPages: valuePathSlug ? await getValuePathAnswerPages() : [],
					baseUrl:
						env.NEXT_PUBLIC_URL ??
						env.NEXT_PUBLIC_SITE_URL ??
						'https://www.aihero.dev',
					pathTokenSecret: env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
					linkAnchors: createDrizzleValuePathLinkAnchorStore(db),
					now: new Date().toISOString(),
					warn: log.warn,
				}),
			bump: (contactId) =>
				createDrizzleContactProfileVersionStore(db).bump(contactId),
		})
	},
)
