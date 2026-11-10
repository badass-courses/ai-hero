import 'server-only'

import { createHash } from 'node:crypto'
import {
	INTEREST_FACT_REQUESTED_EVENT,
	type InterestFactRequested,
} from '@/inngest/events/interest-fact'
import { log } from '@/server/logger'

import {
	interestFactsEnabled,
	interestFieldKeysOf,
	type InterestFieldKey,
} from './interest-facts'

type Sender = { send(events: InterestFactRequested[]): Promise<unknown> }

/**
 * Queue one fact per waitlist or interest key in `fields`, before Kit is
 * touched, so a Kit outage cannot lose a join. Off unless
 * `AIH_INTEREST_FACTS_ENABLED=true`. Never throws: the reader's join is
 * answered by its own path, and a lost fact is a log line, not an error under
 * their cursor.
 *
 * The event id is the list plus a hash of the address, so a double click
 * inside Inngest's dedupe window is one event and the id carries no email.
 */
export async function requestInterestFacts(args: {
	email: string
	fields: unknown
	expressedAt?: Date
	via: InterestFactRequested['data']['via']
	sender?: Sender
}): Promise<{ queued: number }> {
	if (!interestFactsEnabled()) return { queued: 0 }
	const keys = interestFieldKeysOf(args.fields)
	const email = args.email.trim()
	if (keys.length === 0 || !email) return { queued: 0 }
	const expressedAt = (args.expressedAt ?? new Date()).toISOString()
	const emailHash = createHash('sha256')
		.update(email.toLowerCase())
		.digest('hex')
		.slice(0, 32)
	try {
		const sender =
			args.sender ?? (await import('@/inngest/inngest.server')).inngest
		await sender.send(
			keys.map((fieldKey) => ({
				id: `interest-fact:${fieldKey}:${emailHash}`,
				name: INTEREST_FACT_REQUESTED_EVENT,
				data: { email, fieldKey, expressedAt, via: args.via },
			})) as InterestFactRequested[],
		)
		return { queued: keys.length }
	} catch (error) {
		try {
			await log.error('interest.fact.enqueue.failed', {
				fieldKeys: keys,
				via: args.via,
				error: error instanceof Error ? error.name : 'unknown',
			})
		} catch {}
		return { queued: 0 }
	}
}

/**
 * Make sure a join has a contact to land on (see
 * `resolveInterestJoinContact`). Never throws: the join is already queued
 * and answered, and a failure is one log line with no address.
 */
export async function holdInterestJoinContact(args: {
	email: string
	name?: string
	fieldKeys: InterestFieldKey[]
}): Promise<void> {
	try {
		const [
			{ db },
			{ contact },
			{ eq },
			{ DrizzleCaptureMarketingRepository },
			{ resolveInterestJoinContact },
		] = await Promise.all([
			import('@/db'),
			import('@/db/schema'),
			import('drizzle-orm'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
			import('./interest-facts-contact'),
		])
		const { minted } = await resolveInterestJoinContact({
			repository: new DrizzleCaptureMarketingRepository(db),
			findContactIdsByEmailKey: async (emailKey) =>
				(
					await db
						.select({ id: contact.id })
						.from(contact)
						.where(eq(contact.emailKey, emailKey))
						.limit(2)
				).map((row) => row.id),
			email: args.email,
			name: args.name,
			now: new Date().toISOString(),
		})
		if (minted) {
			await log.info('interest.join.contact.minted', {
				fieldKeys: args.fieldKeys,
			})
		}
	} catch (error) {
		try {
			await log.error('interest.join.contact.failed', {
				fieldKeys: args.fieldKeys,
				error: error instanceof Error ? error.name : 'unknown',
			})
		} catch {}
	}
}
