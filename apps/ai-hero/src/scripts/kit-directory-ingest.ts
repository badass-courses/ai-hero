import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

import {
	KIT_DIRECTORY_INGEST_EVENT,
	type KitDirectoryIngest,
	type KitDirectorySubscriber,
} from '@/inngest/events/kit-directory'
import { KIT_DIRECTORY_BATCH_SIZE } from '@/lib/subscriber-marketing/kit-directory-ingest'

const INNGEST_EVENT_KEY_PLACEHOLDER = '[SENSITIVE]'

type ScriptOptions = {
	file: string
	after?: string
	batchSize: number
	send: boolean
	write: boolean
}

function normalizedHeader(value: string): string {
	return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function parseCsvLine(line: string): string[] {
	const values: string[] = []
	let value = ''
	let quoted = false

	for (let index = 0; index < line.length; index++) {
		const character = line[index]
		if (character === '"') {
			if (quoted && line[index + 1] === '"') {
				value += '"'
				index += 1
			} else {
				quoted = !quoted
			}
		} else if (character === ',' && !quoted) {
			values.push(value.trim())
			value = ''
		} else {
			value += character
		}
	}
	if (quoted) throw new Error('CSV row has an unterminated quoted field')
	values.push(value.trim())
	return values
}

export function subscriberFromCsvRow(
	headers: readonly string[],
	values: readonly string[],
): KitDirectorySubscriber | undefined {
	const row = new Map(
		headers.map((header, index) => [header, values[index]?.trim() ?? '']),
	)
	const id =
		row.get('id') ??
		row.get('subscriberid') ??
		row.get('subscriber') ??
		''
	if (!id) return undefined

	const firstName = row.get('firstname') ?? ''
	const lastName = row.get('lastname') ?? ''
	const name = row.get('name') || [firstName, lastName].filter(Boolean).join(' ')
	const email = row.get('email') || row.get('emailaddress')
	const createdAt =
		row.get('createdat') || row.get('created') || row.get('createdon')
	return {
		id,
		...(email ? { email } : {}),
		...(name ? { name } : {}),
		...(createdAt ? { createdAt } : {}),
	}
}

function csvQuoteStateAfterLine(line: string, quoted: boolean): boolean {
	for (let index = 0; index < line.length; index++) {
		if (line[index] !== '"') continue
		if (quoted && line[index + 1] === '"') {
			index += 1
			continue
		}
		quoted = !quoted
	}
	return quoted
}

export async function* readKitDirectoryBatches(
	file: string,
	options: { after?: string; batchSize: number },
): AsyncGenerator<KitDirectorySubscriber[]> {
	const input = createReadStream(resolve(file), { encoding: 'utf8' })
	const lines = createInterface({ input, crlfDelay: Infinity })
	let headers: string[] | undefined
	let batch: KitDirectorySubscriber[] = []
	let recordLines: string[] = []
	let quoted = false

	try {
		for await (const line of lines) {
			if (!line.trim() && recordLines.length === 0) continue
			recordLines.push(line)
			quoted = csvQuoteStateAfterLine(line, quoted)
			if (quoted) continue

			const record = recordLines.join('\n')
			recordLines = []
			quoted = false
			if (!headers) {
				headers = parseCsvLine(record).map(normalizedHeader)
				continue
			}
			const subscriber = subscriberFromCsvRow(headers, parseCsvLine(record))
			if (!subscriber) continue
			if (
				options.after &&
				Number(subscriber.id) <= Number(options.after)
			)
				continue
			batch.push(subscriber)
			if (batch.length >= options.batchSize) {
				yield batch
				batch = []
			}
		}
		if (recordLines.length > 0) {
			throw new Error('CSV row has an unterminated quoted field')
		}
	} finally {
		lines.close()
		input.destroy()
	}

	if (batch.length > 0) yield batch
}

export async function sendKitDirectoryBatch(
	eventKey: string,
	batch: readonly KitDirectorySubscriber[],
	cursor: string | undefined,
	dryRun: boolean,
	fetcher: typeof fetch = fetch,
) {
	const response = await fetcher(
		`https://inn.gs/e/${encodeURIComponent(eventKey)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: KIT_DIRECTORY_INGEST_EVENT,
				data: {
					batch: Array.from(batch),
					...(cursor ? { cursor } : {}),
					dryRun,
				},
			} satisfies KitDirectoryIngest),
		},
	)
	if (!response.ok) {
		throw new Error(`Inngest returned HTTP ${response.status}`)
	}
	return response.json()
}

function parseArgs(argv: readonly string[]): ScriptOptions {
	let file: string | undefined
	let after: string | undefined
	let batchSize: number = KIT_DIRECTORY_BATCH_SIZE
	let send = false
	let write = false

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--') continue
		if (arg === '--file') file = argv[++index]
		else if (arg === '--after') after = argv[++index]
		else if (arg === '--batch-size') batchSize = Number(argv[++index])
		else if (arg === '--send') send = true
		else if (arg === '--write') {
			write = true
			send = true
		} else if (arg === '--help') {
			console.log(
				'Usage: pnpm kit-directory:ingest -- --file <csv> [--after <kit-id>] [--batch-size 500] [--send] [--write]',
			)
			process.exit(0)
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}
	if (!file) throw new Error('--file is required')
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > KIT_DIRECTORY_BATCH_SIZE) {
		throw new Error(`--batch-size must be an integer from 1 to ${KIT_DIRECTORY_BATCH_SIZE}`)
	}
	return { file, after, batchSize, send, write }
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const eventKey = process.env.INNGEST_EVENT_KEY?.trim()
	if (options.send && (!eventKey || eventKey === INNGEST_EVENT_KEY_PLACEHOLDER)) {
		throw new Error('--send requires a usable INNGEST_EVENT_KEY')
	}

	let batches = 0
	let subscribers = 0
	let cursor = options.after
	for await (const batch of readKitDirectoryBatches(options.file, options)) {
		const nextCursor = batch.at(-1)?.id
		if (options.send) {
			await sendKitDirectoryBatch(
				eventKey!,
				batch,
				nextCursor,
				!options.write,
			)
		}
		batches += 1
		subscribers += batch.length
		cursor = nextCursor ?? cursor
		console.log(
			`kit-directory-ingest mode=${options.write ? 'write' : 'dry-run'} batch=${batches} subscribers=${subscribers} cursor=${cursor ?? 'none'}`,
		)
	}
	console.log(
		`kit-directory-ingest complete mode=${options.write ? 'write' : 'dry-run'} batches=${batches} subscribers=${subscribers} cursor=${cursor ?? 'none'} sent=${options.send}`,
	)
}

const invokedPath = process.argv[1]
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
