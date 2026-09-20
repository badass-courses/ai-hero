import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import {
	NEWSLETTER_VETERANS_ASSIGN_EVENT,
	type NewsletterVeteran,
	type NewsletterVeteransAssign,
} from '@/inngest/events/newsletter-veterans'
import { NEWSLETTER_VETERANS_BATCH_SIZE } from '@/lib/subscriber-marketing/newsletter-veterans'

/**
 * Publishes newsletter veteran batches to Inngest.
 *
 *   pnpm newsletter:veterans --file veterans.json [--batch-size 25] [--pace-ms 50000] [--limit N] [--send] [--write]
 *
 * The file is a JSON array of `{ contactId, kitSubscriberId }`. Without
 * `--send` nothing leaves the machine; without `--write` the function only
 * counts. Each assignment dispatches one `contact-event` delivery to drovr,
 * the lane live signups use, so the default pace keeps a batch under what
 * that lane drains in the interval.
 */

export const NEWSLETTER_VETERANS_DEFAULT_BATCH_SIZE = 25 as const
export const NEWSLETTER_VETERANS_DEFAULT_PACE_MS = 50_000 as const

type ScriptOptions = {
	file: string
	batchSize: number
	paceMs: number
	limit?: number
	send: boolean
	write: boolean
}

export function parseVeteransFile(raw: string): NewsletterVeteran[] {
	const parsed: unknown = JSON.parse(raw)
	if (!Array.isArray(parsed)) throw new Error('veterans file must be a JSON array')
	const veterans: NewsletterVeteran[] = []
	for (const entry of parsed) {
		if (
			typeof entry !== 'object' ||
			entry === null ||
			typeof (entry as { contactId?: unknown }).contactId !== 'string' ||
			typeof (entry as { kitSubscriberId?: unknown }).kitSubscriberId !== 'string'
		) {
			throw new Error('every entry needs string contactId and kitSubscriberId')
		}
		const { contactId, kitSubscriberId } = entry as NewsletterVeteran
		veterans.push({ contactId: contactId.trim(), kitSubscriberId: kitSubscriberId.trim() })
	}
	return veterans
}

export function chunkVeterans(
	veterans: readonly NewsletterVeteran[],
	batchSize: number,
): NewsletterVeteran[][] {
	const batches: NewsletterVeteran[][] = []
	for (let index = 0; index < veterans.length; index += batchSize) {
		batches.push(Array.from(veterans.slice(index, index + batchSize)))
	}
	return batches
}

export async function sendNewsletterVeteransBatch(
	eventKey: string,
	batch: readonly NewsletterVeteran[],
	dryRun: boolean,
	fetcher: typeof fetch = fetch,
) {
	const response = await fetcher(
		`https://inn.gs/e/${encodeURIComponent(eventKey)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: NEWSLETTER_VETERANS_ASSIGN_EVENT,
				data: { batch: Array.from(batch), dryRun },
			} satisfies NewsletterVeteransAssign),
		},
	)
	if (!response.ok) {
		throw new Error(`Inngest returned HTTP ${response.status}`)
	}
	return response.json()
}

export function parseArgs(argv: readonly string[]): ScriptOptions {
	let file = ''
	let batchSize: number = NEWSLETTER_VETERANS_DEFAULT_BATCH_SIZE
	let paceMs: number = NEWSLETTER_VETERANS_DEFAULT_PACE_MS
	let limit: number | undefined
	let send = false
	let write = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const next = () => {
			const value = argv[index + 1]
			if (value === undefined) throw new Error(`${arg} needs a value`)
			index += 1
			return value
		}
		if (arg === '--file') file = next()
		else if (arg === '--batch-size') batchSize = Number(next())
		else if (arg === '--pace-ms') paceMs = Number(next())
		else if (arg === '--limit') limit = Number(next())
		else if (arg === '--send') send = true
		else if (arg === '--write') write = true
		else throw new Error(`unknown argument ${arg}`)
	}
	if (!file) throw new Error('--file is required')
	if (
		!Number.isInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > NEWSLETTER_VETERANS_BATCH_SIZE
	) {
		throw new Error(
			`--batch-size must be an integer from 1 to ${NEWSLETTER_VETERANS_BATCH_SIZE}`,
		)
	}
	if (!Number.isInteger(paceMs) || paceMs < 0) throw new Error('--pace-ms must be a non-negative integer')
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
		throw new Error('--limit must be a positive integer')
	}
	return { file, batchSize, paceMs, limit, send, write }
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const eventKey = process.env.INNGEST_EVENT_KEY?.trim()
	if (options.send && !eventKey) {
		throw new Error('--send requires a usable INNGEST_EVENT_KEY')
	}
	const veterans = parseVeteransFile(readFileSync(resolve(options.file), 'utf8'))
	const batches = chunkVeterans(veterans, options.batchSize).slice(
		0,
		options.limit ?? Number.POSITIVE_INFINITY,
	)
	const dryRun = !options.write
	let sent = 0
	for (const [index, batch] of batches.entries()) {
		if (options.send && eventKey) {
			await sendNewsletterVeteransBatch(eventKey, batch, dryRun)
			sent += 1
		}
		console.log(
			`newsletter-veterans batch=${index + 1}/${batches.length} contacts=${batch.length} sent=${options.send ? 1 : 0} mode=${dryRun ? 'dry-run' : 'write'}`,
		)
		if (options.send && index < batches.length - 1 && options.paceMs > 0) {
			await new Promise((resolveSleep) => setTimeout(resolveSleep, options.paceMs))
		}
	}
	console.log(
		`newsletter-veterans complete veterans=${veterans.length} batches=${batches.length} sent=${sent} mode=${dryRun ? 'dry-run' : 'write'}`,
	)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
}
