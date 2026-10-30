/** Dry run ONLY. No apply switch exists and nothing here sends an event.
 * Counts the waitlist and interest joins the single 15-minute wait dropped
 * since interest facts went live (2026-10-29T19:35Z), for a later re-drive.
 *
 * Usage from apps/ai-hero:
 *   SKIP_ENV_VALIDATION=1 tsx scripts/interest-fact-redrive-dry-run.ts --source axiom
 *     Reads the logs with AXIOM_TOKEN (a query key). Logs hold no address.
 *   SKIP_ENV_VALIDATION=1 tsx scripts/interest-fact-redrive-dry-run.ts --source inngest
 *     Reads Inngest event history with INNGEST_SIGNING_KEY. Addresses stay in
 *     memory to dedupe by email key and list; output is counts only.
 *   --since <ISO> overrides the start.
 */
import { INTEREST_FACT_REQUESTED_EVENT } from '../src/inngest/events/interest-fact'
import {
	droppedFromLogRows,
	INTEREST_REDRIVE_SINCE,
	interestFailedRunsAxiomQuery,
	interestRedriveAxiomQuery,
	planInterestRedrive,
	type AxiomInterestRow,
	type InngestRun,
	type InterestRedriveEvent,
} from '../src/lib/cta/interest-fact-redrive'

const INNGEST_API = 'https://api.inngest.com/v1'
const PAGE = 100
const MAX_PAGES = 200

function parseArgs(argv: string[]) {
	let source: 'axiom' | 'inngest' | undefined
	let since = INTEREST_REDRIVE_SINCE
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if (arg === '--source') {
			const value = argv[++i]
			if (value === 'axiom' || value === 'inngest') source = value
		} else if (arg === '--since') {
			since = new Date(argv[++i] ?? '').toISOString()
		} else {
			throw new Error(`unknown argument ${arg}; no apply mode exists`)
		}
	}
	if (!source) throw new Error('--source axiom|inngest is required')
	return { source, since }
}

async function axiomTable(apl: string, since: string, token: string) {
	const response = await fetch(
		'https://api.axiom.co/v1/datasets/_apl?format=tabular',
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ apl, startTime: since }),
		},
	)
	if (!response.ok) throw new Error(`axiom query failed: ${response.status}`)
	const body = (await response.json()) as {
		tables?: { fields: { name: string }[]; columns: unknown[][] }[]
	}
	const table = body.tables?.[0]
	if (!table) return []
	const rows = table.columns[0]?.length ?? 0
	return Array.from({ length: rows }, (_, row) =>
		Object.fromEntries(
			table.fields.map((field, column) => [
				field.name,
				table.columns[column]![row],
			]),
		),
	)
}

async function fromAxiom(since: string) {
	const token = process.env.AXIOM_TOKEN?.trim()
	if (!token) throw new Error('AXIOM_TOKEN is required for --source axiom')
	const rows = (await axiomTable(
		interestRedriveAxiomQuery(),
		since,
		token,
	)) as unknown as AxiomInterestRow[]
	const failed = await axiomTable(interestFailedRunsAxiomQuery(), since, token)
	return {
		source: 'axiom',
		since,
		...droppedFromLogRows(
			rows.map((row) => ({ ...row, total: Number(row.total) })),
		),
		failedRunsHeld: Number(failed[0]?.total ?? 0),
	}
}

async function inngestJson(path: string, signingKey: string) {
	const response = await fetch(`${INNGEST_API}${path}`, {
		headers: { authorization: `Bearer ${signingKey}` },
	})
	if (!response.ok)
		throw new Error(`inngest ${path.split('?')[0]} failed: ${response.status}`)
	return (await response.json()) as { data?: unknown[]; cursor?: string }
}

async function fromInngest(since: string) {
	const signingKey = process.env.INNGEST_SIGNING_KEY?.trim()
	if (!signingKey) {
		throw new Error('INNGEST_SIGNING_KEY is required for --source inngest')
	}
	type ListedEvent = {
		internal_id?: string
		data?: InterestRedriveEvent['data']
	}
	const listed: ListedEvent[] = []
	let cursor: string | undefined
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const params = new URLSearchParams({
			name: INTEREST_FACT_REQUESTED_EVENT,
			received_after: since,
			limit: String(PAGE),
		})
		if (cursor) params.set('cursor', cursor)
		const body = await inngestJson(`/events?${params}`, signingKey)
		const data = (body.data ?? []) as ListedEvent[]
		listed.push(...data)
		const next = body.cursor ?? data.at(-1)?.internal_id
		if (data.length < PAGE || !next || next === cursor) break
		cursor = next
	}
	const events: InterestRedriveEvent[] = []
	for (const event of listed) {
		if (!event.internal_id) continue
		const runs = await inngestJson(
			`/events/${encodeURIComponent(event.internal_id)}/runs`,
			signingKey,
		)
		events.push({
			data: event.data ?? {},
			runs: (runs.data ?? []) as InngestRun[],
		})
	}
	return { source: 'inngest', since, ...planInterestRedrive(events) }
}

async function main() {
	const { source, since } = parseArgs(process.argv.slice(2))
	const report =
		source === 'axiom' ? await fromAxiom(since) : await fromInngest(since)
	console.log(JSON.stringify({ dryRun: true, ...report }, null, 2))
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
