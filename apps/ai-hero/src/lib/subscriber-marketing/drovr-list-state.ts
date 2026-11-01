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

/** Existing drovr MCP capability. A refusal, bad envelope or timeout is unknown. */
export async function readDrovrListState(
	identity: { contactId: string } | { kitSubscriberId: string },
	config: { baseUrl: string; apiKey: string; fetch?: typeof fetch } | undefined,
): Promise<DrovrListState | null> {
	if (!config) return null
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			(async () => {
				const response = await (config.fetch ?? fetch)(
					`${config.baseUrl.replace(/\/$/, '')}/mcp`,
					{
						method: 'POST',
						headers: {
							authorization: `Bearer ${config.apiKey}`,
							'content-type': 'application/json',
							accept: 'application/json, text/event-stream',
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 'aih-list-state',
							method: 'tools/call',
							params: { name: 'get_contact_list_state', arguments: identity },
						}),
						signal: controller.signal,
						cache: 'no-store',
					},
				)
				if (!response.ok) return null
				const envelope = z
					.object({
						jsonrpc: z.literal('2.0'),
						id: z.literal('aih-list-state'),
						result: z.object({
							isError: z.boolean().optional(),
							structuredContent: DrovrListStateReply,
						}),
					})
					.parse(await response.json())
				if (envelope.result.isError) return null
				const result = envelope.result.structuredContent
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
