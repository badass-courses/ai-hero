import { Effect } from 'effect'
import { z } from 'zod'
import { normalizeEmail } from '../contact-email-equivalence'
import {
	preparationSnapshotSchema,
	type MessagePreparationSnapshot,
} from './message-preparation'

export type MessageFieldsTransport = {
	project(
		snapshot: MessagePreparationSnapshot,
	): Promise<'Attempted' | 'Uncertain' | 'Refused'>
	confirm(snapshot: MessagePreparationSnapshot): Promise<boolean>
}
const subscriber = z.object({
	subscriber: z.object({
		id: z.number().int().positive(),
		email_address: z.string().min(1),
		state: z.literal('active'),
		fields: z.record(z.string().nullable()),
	}),
})
/** Documented V3 fields-only protocol used by installed Core's
 * setConvertkitSubscriberFields, WITHOUT its custom-field creation helper.
 * Never use V4 PUT with a stale email_address, nor enrollment-before-fields. */
export function createMessageFieldsTransport(options: {
	apiSecret?: string
	fetch: typeof fetch
	timeoutMs?: number
}): MessageFieldsTransport {
	const timeout = options.timeoutMs ?? 5000
	const secret = options.apiSecret?.trim()
	const configured = Boolean(
		secret &&
		!/[\r\n]/.test(secret) &&
		Number.isFinite(timeout) &&
		timeout > 0 &&
		timeout <= 30000,
	)
	const request = (url: string, init: RequestInit) =>
		Effect.runPromise(
			Effect.tryPromise({
				try: async (signal) => {
					const response = await options.fetch(url, {
						...init,
						signal,
						redirect: 'error',
					})
					if (
						response.redirected ||
						(response.url && response.url !== url) ||
						response.status !== 200
					)
						throw new Error('Unconfirmed Kit field request')
					return (await response.json()) as unknown
				},
				catch: () => new Error('Kit field request unavailable'),
			}).pipe(Effect.timeout(`${timeout} millis`)),
		)
	const read = async (s: MessagePreparationSnapshot) => {
		if (!configured) throw new Error('Field transport unconfigured')
		const url = `https://api.convertkit.com/v3/subscribers/${s.subscriberId}?${new URLSearchParams({ api_secret: secret! })}`
		const p = subscriber.parse(await request(url, { method: 'GET' })).subscriber
		if (
			p.id !== s.subscriberId ||
			normalizeEmail(p.email_address) !== normalizeEmail(s.email)
		)
			throw new Error('Field subscriber identity changed')
		return p
	}
	return {
		async project(input) {
			let s: MessagePreparationSnapshot
			try {
				s = preparationSnapshotSchema.parse(input)
				const current = await read(s)
				if (Object.keys(s.fields).some((k) => !(k in current.fields)))
					return 'Refused'
			} catch {
				return 'Refused'
			}
			try {
				// Only approved keys and values. No email, first_name, tags or enrollment.
				await request(
					`https://api.convertkit.com/v3/subscribers/${s.subscriberId}`,
					{
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ api_secret: secret, fields: s.fields }),
					},
				)
				return 'Attempted'
			} catch {
				return 'Uncertain'
			}
		},
		async confirm(input) {
			try {
				const s = preparationSnapshotSchema.parse(input),
					p = await read(s)
				return Object.entries(s.fields).every(
					([key, value]) => p.fields[key] === value,
				)
			} catch {
				return false
			}
		},
	}
}
