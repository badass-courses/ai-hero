import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	KIT_DIRECTORY_INGEST_EVENT,
	type KitDirectoryIngest,
	type KitDirectorySubscriber,
} from '@/inngest/events/kit-directory'
import type { CaptureMarketingRepository } from '@/lib/subscriber-marketing/capture-contact-event'
import {
	ingestKitDirectoryBatch,
	KIT_DIRECTORY_BATCH_SIZE,
	KIT_DIRECTORY_CONTACT_RETRY_DELAY_MS,
	type KitDirectoryFailure,
} from '@/lib/subscriber-marketing/kit-directory-ingest'

const KIT_API_SUBSCRIBERS_URL = 'https://api.kit.com/v4/subscribers'
const INNGEST_EVENT_KEY_PLACEHOLDER = '[SENSITIVE]'

export const KIT_DIRECTORY_API_PAGE_SIZE = 1000 as const
export const KIT_DIRECTORY_PAGE_DELAY_MS = 600 as const
export const KIT_DIRECTORY_REQUEST_TIMEOUT_MS = 15_000 as const
export const KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS = 1_000 as const
export const KIT_DIRECTORY_MAX_ATTEMPTS = 5 as const
export const KIT_DIRECTORY_RETRY_BASE_MS = 1_000 as const
export const KIT_DIRECTORY_MAX_RETRY_DELAY_MS = 300_000 as const

export type ScriptOptions = {
	status: string
	after?: string
	batchSize: number
	limit?: number
	send: boolean
	write: boolean
	rowsOnly: boolean
	continueOnFailure: boolean
	stateFile?: string
}

type JsonRecord = Record<string, unknown>

type KitDirectoryPagePayload = {
	subscribers: KitDirectorySubscriber[]
	cursor?: string
	hasNextPage: boolean
}

export type KitDirectoryApiPage = KitDirectoryPagePayload & {
	page: number
}

export type KitDirectoryPageSummary = {
	page: number
	subscribers: number
	batches: number
	sentBatches: number
	createdRows?: number
	alreadyPresentRows?: number
	skippedInvalidRows?: number
	failedRows?: number
	failed?: KitDirectoryFailure[]
	writeElapsedMs?: number
	cursor?: string
}

export type KitDirectoryRowsOnlyState = {
	version: 1
	status: string
	page: number
	cursor: string | null
	subscribers: number
	createdRows: number
	alreadyPresentRows: number
	skippedInvalidRows: number
	failedRows: number
	failed: KitDirectoryFailure[]
	writeElapsedMs: number
	updatedAt: string
}

export type RunKitDirectoryIngestArgs = {
	apiKey: string
	status: string
	after?: string
	batchSize: number
	limit?: number
	send: boolean
	write: boolean
	rowsOnly?: boolean
	continueOnFailure?: boolean
	repository?: CaptureMarketingRepository
	eventKey?: string
	fetcher?: typeof fetch
	sleep?: (milliseconds: number) => Promise<void>
	requestTimeoutMs?: number
	maxAttempts?: number
	ingestBatch?: typeof ingestKitDirectoryBatch
	onPage?: (summary: KitDirectoryPageSummary) => void | Promise<void>
}

export type RunKitDirectoryIngestResult = {
	pages: number
	subscribers: number
	batches: number
	sentBatches: number
	createdRows: number
	alreadyPresentRows: number
	skippedInvalidRows: number
	failedRows: number
	failed: KitDirectoryFailure[]
	cursor?: string
	pageSummaries: KitDirectoryPageSummary[]
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}

function subscriberId(value: unknown): string | undefined {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) ? String(value) : undefined
	}
	return stringValue(value)
}

export function mapKitDirectorySubscriber(
	value: unknown,
): KitDirectorySubscriber | undefined {
	if (!isRecord(value)) return undefined
	const id = subscriberId(value.id)
	if (!id) return undefined

	const email = stringValue(value.email_address)
	const name = stringValue(value.first_name)
	const state = stringValue(value.state)
	const createdAt = stringValue(value.created_at)
	return {
		id,
		...(email ? { email } : {}),
		...(name ? { name } : {}),
		...(createdAt ? { createdAt } : {}),
		...(state ? { state } : {}),
	}
}

function parseKitDirectoryPage(payload: unknown): KitDirectoryPagePayload {
	if (!isRecord(payload) || !Array.isArray(payload.subscribers)) {
		throw new Error('Kit API returned an invalid subscribers page')
	}
	const pagination = payload.pagination
	if (
		!isRecord(pagination) ||
		typeof pagination.has_next_page !== 'boolean'
	) {
		throw new Error('Kit API returned invalid pagination')
	}

	return {
		subscribers: payload.subscribers
			.map(mapKitDirectorySubscriber)
			.filter((subscriber): subscriber is KitDirectorySubscriber => Boolean(subscriber)),
		cursor: stringValue(pagination.end_cursor),
		hasNextPage: pagination.has_next_page,
	}
}

function retryBackoffMs(attempt: number) {
	return KIT_DIRECTORY_RETRY_BASE_MS * 2 ** (attempt - 1)
}

function boundedRetryDelay(milliseconds: number) {
	return Number.isFinite(milliseconds) &&
		milliseconds >= 0 &&
		milliseconds <= KIT_DIRECTORY_MAX_RETRY_DELAY_MS
		? milliseconds
		: KIT_DIRECTORY_MAX_RETRY_DELAY_MS
}

function retryAfterMs(response: Response, now: () => number): number | undefined {
	const value = response.headers.get('retry-after')?.trim()
	if (!value) return undefined
	const seconds = Number(value)
	if (Number.isFinite(seconds)) return boundedRetryDelay(seconds * 1_000)
	return boundedRetryDelay(Date.parse(value) - now())
}

function sleep(milliseconds: number) {
	return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

export async function fetchKitDirectoryPage(args: {
	apiKey: string
	status: string
	after?: string
	fetcher?: typeof fetch
	sleep?: (milliseconds: number) => Promise<void>
	requestTimeoutMs?: number
	maxAttempts?: number
	now?: () => number
}): Promise<KitDirectoryPagePayload> {
	const apiKey = args.apiKey.trim()
	if (!apiKey) throw new Error('KIT_API_KEY is required')
	const status = args.status.trim()
	if (!status) throw new Error('--status cannot be empty')
	const requestTimeoutMs =
		args.requestTimeoutMs ?? KIT_DIRECTORY_REQUEST_TIMEOUT_MS
	if (
		!Number.isInteger(requestTimeoutMs) ||
		requestTimeoutMs < KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS ||
		requestTimeoutMs > KIT_DIRECTORY_MAX_RETRY_DELAY_MS
	) {
		throw new Error(
			`Kit request timeout must be an integer from ${KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS} to ${KIT_DIRECTORY_MAX_RETRY_DELAY_MS} milliseconds`,
		)
	}
	const maxAttempts = args.maxAttempts ?? KIT_DIRECTORY_MAX_ATTEMPTS
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error('Kit max attempts must be a positive integer')
	}

	const url = new URL(KIT_API_SUBSCRIBERS_URL)
	url.searchParams.set('status', status)
	url.searchParams.set('per_page', String(KIT_DIRECTORY_API_PAGE_SIZE))
	if (args.after) url.searchParams.set('after', args.after)

	const fetcher = args.fetcher ?? fetch
	const wait = args.sleep ?? sleep
	const now = args.now ?? Date.now
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
		let response: Response | undefined
		try {
			response = await fetcher(url, {
				headers: { 'X-Kit-Api-Key': apiKey },
				signal: controller.signal,
			})
		} catch {
			clearTimeout(timeout)
			if (attempt === maxAttempts) {
				throw new Error(`Kit API request failed after ${maxAttempts} attempts`)
			}
		}
		if (!response) {
			await wait(retryBackoffMs(attempt))
			continue
		}

		if (response.status === 429 || response.status >= 500) {
			clearTimeout(timeout)
			if (attempt === maxAttempts) {
				throw new Error(
					`Kit API returned HTTP ${response.status} after ${maxAttempts} attempts`,
				)
			}
			await wait(
				response.status === 429
					? (retryAfterMs(response, now) ?? retryBackoffMs(attempt))
					: retryBackoffMs(attempt),
			)
			continue
		}
		if (!response.ok) {
			clearTimeout(timeout)
			throw new Error(`Kit API returned HTTP ${response.status}`)
		}

		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			const timedOut = controller.signal.aborted
			clearTimeout(timeout)
			if (timedOut) {
				if (attempt === maxAttempts) {
					throw new Error(
						`Kit API request failed after ${maxAttempts} attempts`,
					)
				}
				await wait(retryBackoffMs(attempt))
				continue
			}
			throw new Error('Kit API returned invalid JSON')
		}
		clearTimeout(timeout)
		return parseKitDirectoryPage(payload)
	}
	throw new Error('Kit API retry loop exhausted')
}

export async function* readKitDirectoryPages(args: {
	apiKey: string
	status: string
	after?: string
	limit?: number
	fetcher?: typeof fetch
	sleep?: (milliseconds: number) => Promise<void>
	requestTimeoutMs?: number
	maxAttempts?: number
}): AsyncGenerator<KitDirectoryApiPage> {
	if (
		args.limit !== undefined &&
		(!Number.isInteger(args.limit) || args.limit < 1)
	) {
		throw new Error('--limit must be a positive integer')
	}

	let after = args.after
	const wait = args.sleep ?? sleep
	for (let page = 1; args.limit === undefined || page <= args.limit; page++) {
		const result = await fetchKitDirectoryPage({
			apiKey: args.apiKey,
			status: args.status,
			after,
			fetcher: args.fetcher,
			sleep: args.sleep,
			requestTimeoutMs: args.requestTimeoutMs,
			maxAttempts: args.maxAttempts,
		})
		yield { ...result, page }

		if (args.limit !== undefined && page >= args.limit) return
		if (!result.hasNextPage) return
		if (!result.cursor) {
			throw new Error('Kit API indicated another page without an end cursor')
		}
		if (result.cursor === after) {
			throw new Error('Kit API returned a repeated pagination cursor')
		}
		after = result.cursor
		await wait(KIT_DIRECTORY_PAGE_DELAY_MS)
	}
}

function batchesOf(
	subscribers: readonly KitDirectorySubscriber[],
	batchSize: number,
) {
	const batches: KitDirectorySubscriber[][] = []
	for (let index = 0; index < subscribers.length; index += batchSize) {
		batches.push(Array.from(subscribers.slice(index, index + batchSize)))
	}
	return batches
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

export async function runKitDirectoryIngest(
	args: RunKitDirectoryIngestArgs,
): Promise<RunKitDirectoryIngestResult> {
	if (
		!Number.isInteger(args.batchSize) ||
		args.batchSize < 1 ||
		args.batchSize > KIT_DIRECTORY_BATCH_SIZE
	) {
		throw new Error(
			`--batch-size must be an integer from 1 to ${KIT_DIRECTORY_BATCH_SIZE}`,
		)
	}
	if (args.rowsOnly && args.send) {
		throw new Error('--rows-only cannot be combined with --send')
	}
	const repository = args.repository
	if (args.rowsOnly && !repository) {
		throw new Error('--rows-only requires a contact repository')
	}
	if (args.send && !args.eventKey?.trim()) {
		throw new Error('--send requires a usable INNGEST_EVENT_KEY')
	}

	const pageSummaries: KitDirectoryPageSummary[] = []
	const ingestBatch = args.ingestBatch ?? ingestKitDirectoryBatch
	let pages = 0
	let subscribers = 0
	let batches = 0
	let sentBatches = 0
	let createdRows = 0
	let alreadyPresentRows = 0
	let skippedInvalidRows = 0
	let failedRows = 0
	const failed: KitDirectoryFailure[] = []
	let cursor = args.after

	for await (const page of readKitDirectoryPages({
		apiKey: args.apiKey,
		status: args.status,
		after: args.after,
		limit: args.limit,
		fetcher: args.fetcher,
		sleep: args.sleep,
		requestTimeoutMs: args.requestTimeoutMs,
		maxAttempts: args.maxAttempts,
	})) {
		const pageBatches = batchesOf(page.subscribers, args.batchSize)
		let pageCreatedRows = 0
		let pageAlreadyPresentRows = 0
		let pageSkippedInvalidRows = 0
		let pageFailedRows = 0
		const pageFailed: KitDirectoryFailure[] = []
		const writeStartedAt = Date.now()
		if (args.rowsOnly) {
			if (!repository) {
				throw new Error('--rows-only requires a contact repository')
			}
			for (const batch of pageBatches) {
				const result = await ingestBatch({
					repository,
					batch,
					dryRun: false,
					suppressBirthDelivery: true,
					continueOnContactError: true,
					contactFailureAttempts: args.continueOnFailure ? 2 : 1,
					contactFailureRetryDelayMs:
						KIT_DIRECTORY_CONTACT_RETRY_DELAY_MS,
					sleep: args.sleep,
				})
				pageCreatedRows += result.counts.created
				pageAlreadyPresentRows += result.counts.alreadyPresent
				pageSkippedInvalidRows += result.counts.skippedInvalid
				pageFailedRows += result.counts.failed
				pageFailed.push(...result.failed)
			}
		} else if (args.send) {
			for (const batch of pageBatches) {
				await sendKitDirectoryBatch(
					args.eventKey!,
					batch,
					page.cursor,
					!args.write,
					args.fetcher,
				)
			}
		}

		pages += 1
		subscribers += page.subscribers.length
		batches += pageBatches.length
		sentBatches += args.send ? pageBatches.length : 0
		createdRows += pageCreatedRows
		alreadyPresentRows += pageAlreadyPresentRows
		skippedInvalidRows += pageSkippedInvalidRows
		failedRows += pageFailedRows
		failed.push(...pageFailed)
		cursor = page.cursor ?? cursor
		const summary: KitDirectoryPageSummary = {
			page: page.page,
			subscribers: page.subscribers.length,
			batches: pageBatches.length,
			sentBatches: args.send ? pageBatches.length : 0,
			...(args.rowsOnly
				? {
						createdRows: pageCreatedRows,
						alreadyPresentRows: pageAlreadyPresentRows,
						skippedInvalidRows: pageSkippedInvalidRows,
						failedRows: pageFailedRows,
						failed: pageFailed,
						writeElapsedMs: Date.now() - writeStartedAt,
					}
				: {}),
			...(cursor ? { cursor } : {}),
		}
		pageSummaries.push(summary)
		await args.onPage?.(summary)
		if (
			args.rowsOnly &&
			!args.continueOnFailure &&
			pageFailed.length > 0
		) {
			throw new Error(
				`Rows-only page ${page.page} failed contacts: ${JSON.stringify(pageFailed)}`,
			)
		}
	}

	if (args.rowsOnly && args.continueOnFailure && failed.length > 0) {
		throw new Error(
			`Rows-only ingest completed with failed contacts: ${JSON.stringify(failed)}`,
		)
	}

	return {
		pages,
		subscribers,
		batches,
		sentBatches,
		createdRows,
		alreadyPresentRows,
		skippedInvalidRows,
		failedRows,
		failed,
		...(cursor ? { cursor } : {}),
		pageSummaries,
	}
}

function nextArgument(argv: readonly string[], index: number, flag: string) {
	const value = argv[index + 1]
	if (!value || value.startsWith('--')) {
		throw new Error(`${flag} requires a value`)
	}
	return value
}

export function parseKitDirectoryIngestArgs(
	argv: readonly string[],
): ScriptOptions {
	let status = 'all'
	let after: string | undefined
	let batchSize: number = KIT_DIRECTORY_BATCH_SIZE
	let limit: number | undefined
	let send = false
	let write = false
	let rowsOnly = false
	let continueOnFailure = false
	let stateFile: string | undefined

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--') continue
		if (arg === '--status') status = nextArgument(argv, index++, arg)
		else if (arg === '--after') after = nextArgument(argv, index++, arg)
		else if (arg === '--batch-size') {
			batchSize = Number(nextArgument(argv, index++, arg))
		} else if (arg === '--limit') {
			limit = Number(nextArgument(argv, index++, arg))
		} else if (arg === '--state-file') {
			stateFile = nextArgument(argv, index++, arg)
		} else if (arg === '--send') send = true
		else if (arg === '--write') write = true
		else if (arg === '--continue-on-failure') continueOnFailure = true
		else if (arg === '--rows-only') {
			rowsOnly = true
			write = true
		} else if (arg === '--help') {
			console.log(
				'Usage: pnpm kit-directory:ingest -- [--status all] [--after <cursor>] [--batch-size 500] [--limit <pages>] [--send] [--write] [--rows-only --state-file <path> [--continue-on-failure]]',
			)
			process.exit(0)
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}

	if (!status.trim()) throw new Error('--status cannot be empty')
	if (
		!Number.isInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > KIT_DIRECTORY_BATCH_SIZE
	) {
		throw new Error(
			`--batch-size must be an integer from 1 to ${KIT_DIRECTORY_BATCH_SIZE}`,
		)
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
		throw new Error('--limit must be a positive integer')
	}
	if (rowsOnly && send) {
		throw new Error('--rows-only cannot be combined with --send')
	}
	if (rowsOnly && !stateFile) {
		throw new Error('--rows-only requires --state-file')
	}
	if (continueOnFailure && !rowsOnly) {
		throw new Error('--continue-on-failure requires --rows-only')
	}
	if (write && !rowsOnly) send = true
	return {
		status,
		after,
		batchSize,
		limit,
		send,
		write,
		rowsOnly,
		continueOnFailure,
		stateFile,
	}
}

export async function writeKitDirectoryRowsOnlyState(
	path: string,
	state: KitDirectoryRowsOnlyState,
) {
	const target = resolve(path)
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
	await mkdir(dirname(target), { recursive: true })
	try {
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		})
		await rename(temporary, target)
	} finally {
		await rm(temporary, { force: true })
	}
}

async function createRowsOnlyRepository() {
	const [{ closeDatabasePool, db }, { DrizzleCaptureMarketingRepository }] =
		await Promise.all([
			import('@/db'),
			import('@/lib/subscriber-marketing/drizzle-capture-repository'),
		])
	return {
		repository: new DrizzleCaptureMarketingRepository(db),
		close: closeDatabasePool,
	}
}

async function main() {
	const options = parseKitDirectoryIngestArgs(process.argv.slice(2))
	const apiKey = process.env.KIT_API_KEY?.trim()
	if (!apiKey) throw new Error('KIT_API_KEY is required')
	const eventKey = process.env.INNGEST_EVENT_KEY?.trim()
	if (options.send && (!eventKey || eventKey === INNGEST_EVENT_KEY_PLACEHOLDER)) {
		throw new Error('--send requires a usable INNGEST_EVENT_KEY')
	}

	const direct = options.rowsOnly
		? await createRowsOnlyRepository()
		: undefined
	const stateFile = options.stateFile
	let checkpointCursor: string | null = options.after ?? null
	const accumulatedFailures: KitDirectoryFailure[] = []
	try {
		const result = await runKitDirectoryIngest({
			...options,
			apiKey,
			eventKey,
			repository: direct?.repository,
			onPage: async (summary) => {
				const pageFailed = summary.failed ?? []
				accumulatedFailures.push(...pageFailed)
				if (options.rowsOnly && stateFile) {
					const canCheckpoint =
						pageFailed.length === 0 || options.continueOnFailure
					const stateCursor = canCheckpoint
						? (summary.cursor ?? checkpointCursor)
						: checkpointCursor
					await writeKitDirectoryRowsOnlyState(stateFile, {
						version: 1,
						status: options.status,
						page: summary.page,
						cursor: stateCursor,
						subscribers: summary.subscribers,
						createdRows: summary.createdRows ?? 0,
						alreadyPresentRows: summary.alreadyPresentRows ?? 0,
						skippedInvalidRows: summary.skippedInvalidRows ?? 0,
						failedRows: accumulatedFailures.length,
						failed: accumulatedFailures,
						writeElapsedMs: summary.writeElapsedMs ?? 0,
						updatedAt: new Date().toISOString(),
					})
					if (canCheckpoint) checkpointCursor = stateCursor
				}
				console.log(
					`kit-directory-ingest page=${summary.page} subscribers=${summary.subscribers} batches=${summary.batches} cursor=${summary.cursor ?? 'none'} sent=${summary.sentBatches} created=${summary.createdRows ?? 0} existing=${summary.alreadyPresentRows ?? 0} failed=${pageFailed.map(({ id }) => id).join(',') || 'none'} writeMs=${summary.writeElapsedMs ?? 0}`,
				)
			},
		})
		const mode = options.rowsOnly
			? 'rows-only'
			: options.write
				? 'write'
				: 'dry-run'
		console.log(
			`kit-directory-ingest complete mode=${mode} status=${options.status} pages=${result.pages} subscribers=${result.subscribers} batches=${result.batches} cursor=${result.cursor ?? 'none'} sent=${result.sentBatches} created=${result.createdRows} existing=${result.alreadyPresentRows} failed=${result.failedRows}`,
		)
	} finally {
		await direct?.close()
	}
}

const invokedPath = process.argv[1]
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
