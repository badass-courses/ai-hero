import { createHmac } from 'node:crypto'
import { supportCreditUrl } from '@/lib/cc-credit/support-client'

export function earlyAccessRequest(args: string[]) {
	const [command, invoiceId, ...rest] = args
	if (!['grant', 'report', 'revoke'].includes(command ?? ''))
		throw new Error(
			'Use grant <in_…> [--apply], report, or revoke <in_…> [--apply]',
		)
	const flags = command === 'report' ? args.slice(1) : rest
	if (
		flags.some((flag) => flag !== '--apply') ||
		(command === 'report' && flags.length)
	)
		throw new Error('Unknown arguments; report is always read-only')
	if (command !== 'report' && !/^in_[a-zA-Z0-9]+$/.test(invoiceId ?? ''))
		throw new Error('A Stripe invoice id (in_…) is required')
	return {
		command: command as 'grant' | 'report' | 'revoke',
		...(command !== 'report' ? { invoiceId } : {}),
		apply: flags.includes('--apply'),
	}
}

export async function postEarlyAccess(
	origin: string,
	input: ReturnType<typeof earlyAccessRequest>,
	secret: string,
	fetcher = fetch,
) {
	if (!secret) throw new Error('SUPPORT_WEBHOOK_SECRET is required')
	const url = new URL('/api/support/early-access', supportCreditUrl(origin))
	const body = JSON.stringify(input)
	const timestamp = Math.floor(Date.now() / 1000)
	const signature = createHmac('sha256', secret)
		.update(`${timestamp}.${body}`)
		.digest('hex')
	const response = await fetcher(url, {
		method: 'POST',
		body,
		redirect: 'error',
		headers: {
			'content-type': 'application/json',
			'x-support-signature': `timestamp=${timestamp},v1=${signature}`,
		},
	})
	return {
		ok: response.ok,
		status: response.status,
		result: await response.json(),
	}
}
