import { createHmac } from 'node:crypto'

export function deskCreditMode(mode: string, apply = false) {
	if (
		!['reserve', 'reconcile', 'balance', 'inspect', 'backfill'].includes(mode)
	)
		throw new Error(
			'Use mode reserve, reconcile, balance, inspect, or backfill',
		)
	if (apply) return mode
	return mode === 'reserve'
		? 'inspect'
		: mode === 'reconcile'
			? 'reconcile_preview'
			: mode === 'backfill'
				? 'backfill_preview'
				: mode
}
export function supportCreditUrl(origin: string) {
	const url = new URL(origin)
	const production =
		['www.aihero.dev', 'aihero.dev'].includes(url.hostname) &&
		url.protocol === 'https:' &&
		!url.port
	const local =
		['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
		url.protocol === 'http:'
	if ((!production && !local) || url.username || url.password)
		throw new Error(
			'Use the AI Hero production origin or a local test origin, never a preview.',
		)
	return new URL('/api/support/cc-credit', url).toString()
}
export async function postCreditRequest(
	origin: string,
	input: unknown,
	secret: string,
	fetcher: typeof fetch = fetch,
) {
	if (!secret)
		throw new Error('SUPPORT_WEBHOOK_SECRET is required in the environment')
	const body = JSON.stringify(input)
	const timestamp = Math.floor(Date.now() / 1000)
	const signature = createHmac('sha256', secret)
		.update(`${timestamp}.${body}`)
		.digest('hex')
	const response = await fetcher(supportCreditUrl(origin), {
		method: 'POST',
		body,
		redirect: 'error',
		headers: {
			'Content-Type': 'application/json',
			'x-support-signature': `timestamp=${timestamp},v1=${signature}`,
		},
	})
	const result: unknown = await response.json()
	return { ok: response.ok, status: response.status, result }
}
