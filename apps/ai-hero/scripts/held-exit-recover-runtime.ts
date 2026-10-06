import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { z } from 'zod'
import type { CaptureMarketingRepository } from '../src/lib/subscriber-marketing/capture-contact-event'
import type { RecoveryArgs, RecoveryRuntime, RecoverySnapshot } from './held-exit-recover'
import { drovrOutboxTarget } from '../src/lib/subscriber-marketing/drovr-outbox'
import { RecoveryRefused } from './held-exit-recover'
import { readKitExitMembership } from './held-exit-kit-scan'
import { NEWSLETTER_EXIT_CONFIRMED_EVENT } from '../src/inngest/events/newsletter-exit'
import {
	readOldSequenceMembership, OLD_NEWSLETTER_ABSENT, OLD_NEWSLETTER_SUBSCRIBED,
	OLD_NEWSLETTER_ENROLLMENT_REQUESTED, OLD_NEWSLETTER_EXIT_CONFIRMED,
	NEWSLETTER_ADMISSION_HELD, NEWSLETTER_EXIT_REQUIRED,
} from '../src/lib/subscriber-marketing/old-newsletter-exit'
import {
	mapDrovrShadowFact, DROVR_AUTHORITY_TENANT_ID, DROVR_SHADOW_TENANT_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
} from '../src/lib/subscriber-marketing/drovr-shadow-emitter'

const outboxRowsSchema = z.array(z.object({ status: z.enum(['pending', 'delivered', 'rejected', 'held']), attempts: z.number().int().nonnegative() }))

/** Lazy, operator-only loader. Never import or call this factory in a dry fixture.
 * The readonly modes issue SELECTs only. The only write port is createContactEvent. */
export async function createProductionHeldRecoveryRuntime(args: RecoveryArgs) {
	const apiKey = (process.env.KIT_V4_API_KEY ?? process.env.CONVERTKIT_V4_API_KEY ?? '').trim()
	const eventKey = process.env.INNGEST_EVENT_KEY?.trim() ?? ''
	if ((args.mode !== 'readback' && !apiKey) || (args.mode === 'write' && !eventKey))
		throw new RecoveryRefused({ reason: 'runtime-unavailable' })
	const [{ db, closeDatabasePool }, schema, { DrizzleCaptureMarketingRepository, toSideEffectIntentRecord }] = await Promise.all([
		import('../src/db'), import('../src/db/schema'),
		import('../src/lib/subscriber-marketing/drizzle-capture-repository'),
	])
	const repository = new DrizzleCaptureMarketingRepository(db)
	const target = drovrOutboxTarget({ VERCEL_ENV: process.env.VERCEL_ENV, VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF })
	const runtime = createHeldRecoveryPorts({ repository, apiKey, eventKey, fetch, now: () => new Date().toISOString(),
		findRows: async (contactId) => {
			// Two is enough to prove ambiguity; never silently choose a row.
			const rows = await db.select().from(schema.sideEffectIntent).where(and(
				eq(schema.sideEffectIntent.contactId, contactId),
				eq(schema.sideEffectIntent.type, 'subscribe-evergreen-list'),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${schema.sideEffectIntent.metadata}, '$.list')) = ${'shadow-newsletter'}`,
			)).limit(2)
			return rows.map(toSideEffectIntentRecord)
		},
		findKitIdentities: (contactId) => db.select({ id: schema.providerIdentity.id,
			contactId: schema.providerIdentity.contactId, externalId: schema.providerIdentity.externalId,
		}).from(schema.providerIdentity).where(and(eq(schema.providerIdentity.contactId, contactId),
			eq(schema.providerIdentity.provider, 'kit'))).limit(2),
		readOutbox: async (lookup) => {
			const rows = await db.select({ status: schema.drovrOutbox.status, attempts: schema.drovrOutbox.attempts })
				.from(schema.drovrOutbox).where(and(eq(schema.drovrOutbox.target, target),
					eq(schema.drovrOutbox.contactId, lookup.contactId), eq(schema.drovrOutbox.endpoint, 'events'),
					eq(schema.drovrOutbox.tenantId, lookup.tenantId), eq(schema.drovrOutbox.journeyId, lookup.journeyId),
					eq(schema.drovrOutbox.eventType, 'shadow.entered'), eq(schema.drovrOutbox.idempotencyKey, lookup.idempotencyKey)))
			return outboxRowsSchema.parse(rows)
		},
	})
	return { runtime, close: closeDatabasePool }
}

export type RecoveryPortOptions = {
	repository: Pick<CaptureMarketingRepository, 'findContactById' | 'createContactEvent'> &
		Required<Pick<CaptureMarketingRepository, 'findContactEventsByType'>>
	findRows: (contactId: string) => Promise<RecoverySnapshot['rows']>
	findKitIdentities: (contactId: string) => Promise<RecoverySnapshot['identities']>
	readOutbox: (lookup: { contactId: string; tenantId: string; journeyId: string; idempotencyKey: string }) =>
		Promise<{ status: 'pending' | 'delivered' | 'rejected' | 'held'; attempts: number }[]>
	apiKey: string
	eventKey: string
	fetch: typeof fetch
	now: () => string
}
const ownerSchema = z.object({
	tenantId: z.enum([DROVR_AUTHORITY_TENANT_ID, DROVR_SHADOW_TENANT_ID]),
	journeyId: z.literal(DROVR_EVERGREEN_OFFER_JOURNEY_ID), intentKey: z.string().min(1),
})
const acknowledgement = z.object({ status: z.literal(200), ids: z.array(z.string().min(1)).min(1) })
const historyTypes = [OLD_NEWSLETTER_ABSENT, OLD_NEWSLETTER_SUBSCRIBED,
	OLD_NEWSLETTER_ENROLLMENT_REQUESTED, OLD_NEWSLETTER_EXIT_CONFIRMED,
	NEWSLETTER_ADMISSION_HELD, NEWSLETTER_EXIT_REQUIRED, 'newsletter.admission.resumed',
	'journey.owner.assigned', 'newsletter.shadow.protected-cohort', 'newsletter.shadow.cohort-clear']

/** External I/O seams only. The proof writer and local proof reader are the
 * existing library, not alternate persistence or a second replay implementation. */
export function createHeldRecoveryPorts(options: RecoveryPortOptions): RecoveryRuntime {
	return {
		approvalScope: 'not-yet-bound',
		now: options.now,
		findContactById: async (id) => options.repository.findContactById(id),
		inspect: async (contactId) => {
			const [rows, identities, histories] = await Promise.all([
				options.findRows(contactId), options.findKitIdentities(contactId),
				Promise.all(historyTypes.map((type) => options.repository.findContactEventsByType(contactId, type))),
			])
			return { rows, identities, history: histories.flat() }
		},
		scan: (subscriberId) => Effect.runPromise(readKitExitMembership({ apiKey: options.apiKey,
			subscriberId, fetch: options.fetch, now: options.now })),
		persist: async (input) => options.repository.createContactEvent(input),
		currentMembership: async (contactId) => readOldSequenceMembership(options.repository, contactId),
		notify: async ({ contactId, receiptId }) => {
			if (!options.eventKey.trim()) throw new RecoveryRefused({ reason: 'notification-unavailable' })
			const response = await options.fetch(`https://inn.gs/e/${encodeURIComponent(options.eventKey.trim())}`, {
				method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
				headers: { 'content-type': 'application/json' }, body: JSON.stringify({
					id: `held-exit-recover:${receiptId}`, name: NEWSLETTER_EXIT_CONFIRMED_EVENT,
					data: { contactId, receiptId },
				}),
			})
			if (response.status !== 200 || response.redirected) throw new RecoveryRefused({ reason: 'notification-unavailable' })
			const body: unknown = await response.json()
			const decoded = acknowledgement.safeParse(body)
			if (!decoded.success) throw new RecoveryRefused({ reason: 'notification-unavailable' })
			return decoded.data.ids.length
		},
		readback: async (row) => {
			const owner = ownerSchema.safeParse(row.metadata.drovr)
			if (!owner.success) throw new RecoveryRefused({ reason: 'readback-unavailable' })
			const idempotencyKey = `completion:${owner.data.intentKey}`
			// Use the same completion mapper as the sender. A timestamp is not a delivery receipt.
			const events = mapDrovrShadowFact({ kind: 'side-effect-intent-completed', intent: row })
			const eventDerivable = row.status === 'completed' && events.some((event) =>
				event.type === 'shadow.entered' && event.contactId === row.contactId && event.idempotencyKey === idempotencyKey)
			const outbox = await options.readOutbox({ contactId: row.contactId,
				tenantId: owner.data.tenantId, journeyId: owner.data.journeyId, idempotencyKey })
			return { eventDerivable, outbox }
		},
	}
}
