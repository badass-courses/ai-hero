import { z } from 'zod'

const IdentitiesReply = z.object({
	identities: z.array(
		z.object({
			kitSubscriberId: z.string(),
			contactId: z.string().min(1),
		}),
	),
})
const SuppressionsReply = z.object({
	suppressions: z.array(
		z.object({
			contactId: z.string(),
			scope: z.literal('all'),
			lifted: z.literal(false),
			// Unknown future stop reasons must never become DOI consent.
			reason: z.string().min(1),
		}),
	),
	nextCursor: z.string().nullable(),
})

/** Read-only org-aihero REST contracts: directory identities, then active all stops. */
export async function readDrovrOptOuts(
	kitSubscriberId: string,
	config: { baseUrl: string; apiKey: string; fetch?: typeof fetch } | undefined,
	onUnexpectedPage?: () => void | Promise<void>,
): Promise<{ reason: string }[]> {
	if (!config) throw new Error('Drovr opt-out reader is not configured')
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	// One 1.5s budget covers both reads, all pages and their bodies. No retries.
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new DOMException('Drovr opt-out read timed out', 'TimeoutError'))
		}, 1500)
	})
	const fetcher = config.fetch ?? fetch
	const baseUrl = config.baseUrl.replace(/\/$/, '')
	const read = async (path: string, body?: unknown): Promise<unknown> => {
		controller.signal.throwIfAborted()
		const response = await fetcher(`${baseUrl}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: controller.signal,
		})
		if (!response.ok) throw new Error('Drovr opt-out read failed')
		return response.json()
	}
	const lookup = async () => {
		const { identities } = IdentitiesReply.parse(
			await read('/journeys/contact-directory/identities', {
				kitSubscriberIds: [kitSubscriberId],
			}),
		)
		if (identities.length === 0) return []
		if (
			identities.length !== 1 ||
			identities[0]!.kitSubscriberId !== kitSubscriberId
		) {
			throw new TypeError('Unexpected drovr directory identity')
		}
		const contactId = identities[0]!.contactId
		const stops: { reason: string }[] = []
		const cursors = new Set<string>()
		let cursor: string | null = null
		let pageCount = 0
		do {
			const query = new URLSearchParams({
				contactId,
				scope: 'all',
				activeOnly: 'true',
			})
			if (cursor !== null) query.set('cursor', cursor)
			controller.signal.throwIfAborted()
			if (++pageCount === 2) await onUnexpectedPage?.()
			const page = SuppressionsReply.parse(await read(`/suppressions?${query}`))
			if (page.suppressions.some((stop) => stop.contactId !== contactId)) {
				throw new TypeError('Unexpected drovr suppression contact')
			}
			stops.push(...page.suppressions.map(({ reason }) => ({ reason })))
			cursor = page.nextCursor
			if (cursor !== null) {
				if (cursors.has(cursor))
					throw new TypeError('Repeated drovr suppression cursor')
				cursors.add(cursor)
			}
		} while (cursor !== null)
		return stops
	}
	try {
		return await Promise.race([lookup(), deadline])
	} finally {
		clearTimeout(timer)
	}
}
