import {
	emailListProvider,
	setKitSubscriberFields,
} from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import {
	OPTIN_DEFERRED_EVENT,
	type OptInDeferred,
} from '@/inngest/events/optin-deferred'
import {
	SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
	type SkillsNewsletterSubscribed,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import {
	reconcileAiHeroEmailOptInWithKit,
	optInEmailHash,
	routeReturningUnsubscriberWithKit,
} from '@/lib/subscriber-marketing/ai-hero-email-opt-in.server'
import {
	AIH_COURSE_ENTRY_EVIDENCE_FIELD,
	serializeDeadlineTimeZoneEvidenceForKit,
} from '@/lib/subscriber-marketing/course-sequence-exhaustion'
import {
	AIH_OPTIN_ATTRIBUTION_FIELD,
	serializeOptInAttributionForKit,
} from '@/lib/subscriber-marketing/opt-in-attribution-stash'
import { log } from '@/server/logger'

/**
 * Re-read waits after the first immediate attempt: nine reads over about
 * fifty-four minutes, so a drovr outage shorter than an hour still ends in
 * a decision.
 */
export const OPTIN_DEFERRED_BACKOFF = [
	'10s',
	'30s',
	'1m',
	'2m',
	'5m',
	'10m',
	'15m',
	'20m',
] as const

type Verdict = 'clear' | 'unknown' | 'stopped'

type Step = {
	run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
	sleep: (id: string, duration: string) => Promise<unknown>
}

export type DeferredOptInDeps = {
	/** One drovr read: the same decision the route would have made. */
	readVerdict: (data: OptInDeferred['data']) => Promise<Verdict>
	/** The Kit subscribe the route would have done. */
	subscribe: (data: OptInDeferred['data']) => Promise<void>
	/** Post-subscribe work the route does; failures are logged, never fatal. */
	afterSubscribe: (data: OptInDeferred['data']) => Promise<void>
}

/**
 * Finish a sign-up whose drovr opt-out state was unreadable. It subscribes to
 * Kit only after drovr answers "no all stop"; an opt-out or exhausted
 * retries never subscribe. Each read and the subscribe are memoized steps,
 * so a retry of the run cannot subscribe twice.
 */
export async function runDeferredOptIn(
	{ event, step }: { event: { data: OptInDeferred['data'] }; step: Step },
	deps: DeferredOptInDeps,
) {
	const { data } = event
	const base = {
		formId: data.formId,
		entry: data.entry,
		action: data.action,
		emailHash: optInEmailHash(data.email),
		submissionKey: data.submissionKey,
	}

	let verdict: Verdict = 'unknown'
	for (let attempt = 0; attempt <= OPTIN_DEFERRED_BACKOFF.length; attempt++) {
		verdict = await step.run(`read-drovr-${attempt}`, () =>
			deps.readVerdict(data),
		)
		if (verdict !== 'unknown') break
		const wait = OPTIN_DEFERRED_BACKOFF[attempt]
		if (wait) await step.sleep(`backoff-${attempt}`, wait)
	}

	if (verdict === 'unknown') {
		await log.error('optin.deferred.gave_up', {
			...base,
			attempts: OPTIN_DEFERRED_BACKOFF.length + 1,
		})
		return { status: 'gave_up' as const }
	}
	if (verdict === 'stopped') {
		await log.info('optin.deferred.suppressed', base)
		return { status: 'suppressed' as const }
	}

	// Re-read inside the step: if the Kit call fails and the step retries, the
	// memoized "clear" above may be stale and the person may have opted out.
	const outcome = await step.run('subscribe-kit', async () => {
		const latest = await deps.readVerdict(data)
		if (latest === 'unknown') throw new Error('drovr state unknown, retrying')
		if (latest === 'stopped') return 'suppressed' as const
		await deps.subscribe(data)
		return 'subscribed' as const
	})
	if (outcome === 'suppressed') {
		await log.info('optin.deferred.suppressed', base)
		return { status: 'suppressed' as const }
	}
	await log.info('optin.deferred.subscribed', base)
	await step.run('after-subscribe', async () => {
		try {
			await deps.afterSubscribe(data)
		} catch (error) {
			// Kit already has the subscriber; the hourly reconciler covers path
			// entry. Do not retry the run over post-processing.
			await log.error('optin.deferred.after_subscribe_failed', {
				...base,
				error: error instanceof Error ? error.name : 'unknown',
			})
		}
	})
	return { status: 'subscribed' as const }
}

export const optinDeferredDeps: DeferredOptInDeps = {
	readVerdict: async (data) => {
		try {
			const result = await routeReturningUnsubscriberWithKit({
				email: data.email,
				name: data.name,
				kitFormId: data.formId,
				page: data.page,
				optInAttribution: data.optInAttribution,
				entry: data.entry,
				deferral: { queue: false, action: data.action },
			})
			if (result.status === 'not-unsubscribed') return 'clear'
			if (result.status === 'deferred' || result.status === 'lookup-failed') {
				return 'unknown'
			}
			return 'stopped'
		} catch {
			return 'unknown'
		}
	},
	subscribe: async (data) => {
		await emailListProvider.subscribeToList({
			listId: data.formId,
			listType: 'form',
			user: { email: data.email, name: data.name } as any,
			fields: Object.fromEntries(
				Object.entries(data.fields ?? {}).filter(
					(entry): entry is [string, string] => typeof entry[1] === 'string',
				),
			),
		})
	},
	afterSubscribe: async (data) => {
		// Only the skills newsletter form enters the value path from Kit; the
		// older default form (8447166) has no post-subscribe work.
		if (data.formId !== 9376133) return
		const subscriber = await emailListProvider.getSubscriberByEmail(data.email)
		if (!subscriber?.id) return
		const optIn = await reconcileAiHeroEmailOptInWithKit({
			email: data.email,
			subscriberState: subscriber.state,
			mayRemoveUnsubscribeTag: false,
		})
		if (optIn.status === 'confirmation-required') {
			// Enrollment happens later from Kit data via the confirmation
			// reconciler; stash the attribution that only this event still has.
			const fields: Record<string, string> = {}
			const attribution = data.optInAttribution
				? serializeOptInAttributionForKit(data.optInAttribution)
				: undefined
			if (attribution) fields[AIH_OPTIN_ATTRIBUTION_FIELD] = attribution
			if (data.deadlineTimeZone) {
				fields[AIH_COURSE_ENTRY_EVIDENCE_FIELD] =
					serializeDeadlineTimeZoneEvidenceForKit(data.deadlineTimeZone)
			}
			if (Object.keys(fields).length > 0) {
				await setKitSubscriberFields({
					subscriber: { id: subscriber.id, fields: subscriber.fields },
					fields,
					convertkitApiSecret: env.CONVERTKIT_API_SECRET,
					convertkitApiKey: env.CONVERTKIT_API_KEY,
				})
			}
			return
		}
		const event: SkillsNewsletterSubscribed = {
			name: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT,
			data: {
				kitSubscriberId: String(subscriber.id),
				email: data.email,
				name: data.name,
				formId: 9376133,
				source:
					typeof data.fields?.source === 'string'
						? data.fields.source
						: 'aihero_skills_page',
				subscribedAt: new Date().toISOString(),
				...(data.deadlineTimeZone
					? { deadlineTimeZone: data.deadlineTimeZone }
					: {}),
				optInAttribution: data.optInAttribution,
			},
		}
		await inngest.send(event)
	},
}

export const optinDeferredSubscribe = inngest.createFunction(
	{
		id: 'optin-deferred-subscribe',
		retries: 4,
		// One run per submission; a repeat event with the same key is dropped.
		idempotency: 'event.data.submissionKey',
	},
	{ event: OPTIN_DEFERRED_EVENT },
	async ({ event, step }) =>
		runDeferredOptIn({ event, step: step as unknown as Step }, optinDeferredDeps),
)
