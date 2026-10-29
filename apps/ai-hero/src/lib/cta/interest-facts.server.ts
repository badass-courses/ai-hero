import 'server-only'

import { createHash } from 'node:crypto'
import {
	INTEREST_FACT_REQUESTED_EVENT,
	type InterestFactRequested,
} from '@/inngest/events/interest-fact'
import { log } from '@/server/logger'

import { interestFactsEnabled, interestFieldKeysOf } from './interest-facts'

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
