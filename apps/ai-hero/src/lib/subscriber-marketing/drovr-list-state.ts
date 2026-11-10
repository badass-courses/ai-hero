import { z } from 'zod'

export const DrovrListStateReply = z.object({
	contactId: z.string().nullable(),
	kitSubscriberId: z.string().nullable(),
	tenantId: z.literal('org-aihero'),
	scope: z.literal('all'),
	state: z.enum(['confirmed', 'unconfirmed', 'stopped', 'unknown']),
	forms: z.array(
		z.object({
			formId: z.string(),
			state: z.enum(['confirmed', 'unconfirmed']),
		}),
	),
	stops: z.array(
		z.object({
			createdAt: z.string(),
			reason: z.enum(['bounced', 'complained', 'unsubscribed']),
			scope: z.string(),
		}),
	),
	unknownReason: z.enum(['no-contact', 'no-consent-evidence']).nullable(),
})
export type DrovrListState = z.infer<typeof DrovrListStateReply>

/** Existing drovr list-state REST read. A refusal, bad body or timeout is unknown. */
export async function readDrovrListState(
	identity: { contactId: string } | { kitSubscriberId: string },
	config: { baseUrl: string; apiKey: string; fetch?: typeof fetch } | undefined,
): Promise<DrovrListState | null> {
	if (!config) return null
	const entries = Object.entries(identity)
	if (
		entries.length !== 1 ||
		!['contactId', 'kitSubscriberId'].includes(entries[0]![0]) ||
		typeof entries[0]![1] !== 'string' ||
		!entries[0]![1].trim()
	)
		return null
	const query = new URLSearchParams(entries)
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			(async () => {
				const response = await (config.fetch ?? fetch)(
					`${config.baseUrl.replace(/\/$/, '')}/contact-list-state?${query}`,
					{
						method: 'GET',
						headers: {
							authorization: `Bearer ${config.apiKey}`,
							accept: 'application/json',
						},
						signal: controller.signal,
						cache: 'no-store',
					},
				)
				if (!response.ok) return null
				const result = DrovrListStateReply.parse(await response.json())
				if ('contactId' in identity && result.contactId !== identity.contactId)
					return null
				if (
					'kitSubscriberId' in identity &&
					result.kitSubscriberId !== identity.kitSubscriberId
				)
					return null
				return result
			})(),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => {
					controller.abort()
					resolve(null)
				}, 1500)
			}),
		])
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}
