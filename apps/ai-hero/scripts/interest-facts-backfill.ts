/** Backfill Kit's waitlist and interest holders as owned facts. Dry run by
 * default: counts only, nothing sent.
 *
 * Usage from apps/ai-hero:
 *   pnpm interest-facts:backfill --input /path/to/subscribers.jsonl
 *     Dry run. Counts holders per key by Kit state, and how many the local
 *     resolver and drovr resolve_contacts know. Reads DATABASE_URL, and
 *     DROVR_API_BASE_URL (or DROVR_SHADOW_INGEST_URL) plus
 *     DROVR_API_KEY_ORG_AIHERO when set. Every read is a SELECT or a resolve.
 *   pnpm interest-facts:backfill --input <path> --send
 *     Queues aihero/interest.fact.requested with via 'backfill' for each
 *     holder both stores know, at --rate events a second (default 2). Needs
 *     INNGEST_EVENT_KEY. Touch the stop file printed at start to stop after
 *     the current batch; rerun to continue from the progress file.
 *   --keys a,b             only these live keys (default: all four)
 *   --rate <n>             events per second (default 2)
 *   --include-unresolved   also send holders a store does not know; each run
 *                          then waits up to 7 days for the person
 *   --stop-file <path>     default ~/.cache/ai-hero/interest-backfill/STOP
 *   --progress-file <path> default ~/.cache/ai-hero/interest-backfill/progress.json
 *
 * Addresses stay in memory. Output is counts only.
 */
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import {
	backfillKeys,
	BackfillRefused,
	runInterestBackfill,
	type BackfillEvent,
} from '../src/lib/cta/interest-fact-backfill'

const STATE_DIR = join(homedir(), '.cache', 'ai-hero', 'interest-backfill')

function parseArgs(argv: string[]) {
	let input: string | undefined
	let keys: string | undefined
	let send = false
	let rate = 2
	let includeUnresolved = false
	let stopFile = join(STATE_DIR, 'STOP')
	let progressFile = join(STATE_DIR, 'progress.json')
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		const value = () => {
			const next = argv[++i]
			if (!next) throw new BackfillRefused(`${arg} needs a value`)
			return next
		}
		if (arg === '--input') input = value()
		else if (arg === '--keys') keys = value()
		else if (arg === '--send') send = true
		else if (arg === '--dry-run') send = false
		else if (arg === '--rate') rate = Number(value())
		else if (arg === '--include-unresolved') includeUnresolved = true
		else if (arg === '--stop-file') stopFile = value()
		else if (arg === '--progress-file') progressFile = value()
		else throw new BackfillRefused(`unknown argument ${arg}`)
	}
	if (!input) throw new BackfillRefused('--input <subscribers.jsonl> is required')
	return {
		input,
		keys: backfillKeys(keys),
		send,
		rate,
		includeUnresolved,
		stopFile,
		progressFile,
	}
}

const Progress = z.object({
	keys: z.array(z.string()),
	inputBytes: z.number(),
	includeUnresolved: z.boolean(),
	line: z.number().int().nonnegative(),
})

const Acknowledgement = z.object({
	status: z.literal(200),
	ids: z.array(z.string().min(1)),
})

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const inputBytes = (await stat(args.input)).size
	const scope = {
		keys: args.keys,
		inputBytes,
		includeUnresolved: args.includeUnresolved,
	}

	const eventKey = process.env.INNGEST_EVENT_KEY?.trim() ?? ''
	if (args.send && !eventKey)
		throw new BackfillRefused('INNGEST_EVENT_KEY is required for --send')

	const [
		{ db, closeDatabasePool },
		store,
		{ resolveDrovrContacts },
		{ drovrApiKeyForTenant },
		{ resolveDrovrApiBaseUrl },
	] = await Promise.all([
		import('../src/db/client'),
		import('../src/lib/cta/interest-fact-store'),
		import('../src/lib/subscriber-marketing/drovr-purchase-resolve'),
		import('../src/lib/subscriber-marketing/drovr-shadow-emitter'),
		import('../src/lib/subscriber-marketing/drovr-unsubscribe-page'),
	])
	const baseUrl = resolveDrovrApiBaseUrl({
		DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
		DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
	})
	const apiKey = drovrApiKeyForTenant('org-aihero', {
		authorityApiKey: process.env.DROVR_API_KEY_ORG_AIHERO,
	})
	const drovrConfig = baseUrl && apiKey ? { baseUrl, apiKey } : undefined

	console.error(
		JSON.stringify({
			mode: args.send ? 'send' : 'dry-run',
			keys: args.keys,
			ratePerSecond: args.rate,
			drovrResolution: drovrConfig ? 'configured' : 'not-configured',
			...(args.send
				? { stopFile: args.stopFile, progressFile: args.progressFile }
				: {}),
		}),
	)

	const lines = createInterface({
		input: createReadStream(args.input, { encoding: 'utf8' }),
		crlfDelay: Infinity,
	})
	try {
		const report = await runInterestBackfill({
			mode: args.send ? 'send' : 'dry-run',
			keys: args.keys,
			lines,
			findContactIdForEmail: (email) =>
				store.findContactIdForEmail(db, email),
			resolveDrovr: drovrConfig
				? (emails) => resolveDrovrContacts({ emails, config: drovrConfig })
				: undefined,
			send: async (events: BackfillEvent[]) => {
				const response = await fetch(
					`https://inn.gs/e/${encodeURIComponent(eventKey)}`,
					{
						method: 'POST',
						redirect: 'error',
						signal: AbortSignal.timeout(15_000),
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(events),
					},
				)
				// Never echo the URL: it holds the event key.
				if (response.status !== 200)
					throw new BackfillRefused(`inngest send failed: ${response.status}`)
				const ack = Acknowledgement.safeParse(await response.json())
				if (!ack.success || ack.data.ids.length !== events.length)
					throw new BackfillRefused('inngest send not acknowledged')
			},
			stopRequested: () =>
				access(args.stopFile).then(
					() => true,
					() => false,
				),
			readCursor: async () => {
				const raw = await readFile(args.progressFile, 'utf8').catch(
					() => undefined,
				)
				if (raw === undefined) return 0
				const progress = Progress.parse(JSON.parse(raw))
				if (
					JSON.stringify(progress.keys) !== JSON.stringify(scope.keys) ||
					progress.inputBytes !== scope.inputBytes ||
					progress.includeUnresolved !== scope.includeUnresolved
				) {
					throw new BackfillRefused(
						'progress file is for another input, key set or mode; pass a new --progress-file',
					)
				}
				return progress.line
			},
			writeCursor: async (line) => {
				await mkdir(dirname(args.progressFile), { recursive: true })
				await writeFile(
					args.progressFile,
					JSON.stringify({ ...scope, line }, null, 2),
				)
			},
			clock: {
				now: () => Date.now(),
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			},
			ratePerSecond: args.rate,
			includeUnresolved: args.includeUnresolved,
		})
		console.log(JSON.stringify(report, null, 2))
	} finally {
		lines.close()
		await closeDatabasePool()
	}
}

main().catch((error) => {
	// Only our own refusals are printed; provider and SQL text can hold
	// customer data.
	console.error(
		error instanceof BackfillRefused
			? `interest-facts-backfill refused: ${error.message}`
			: `interest-facts-backfill failed: ${
					error instanceof Error ? error.name : 'unknown'
				}`,
	)
	process.exitCode = 1
})
