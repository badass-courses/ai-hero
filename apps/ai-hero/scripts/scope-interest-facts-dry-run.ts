/** Database reads must use aihero-support/tmp/db/reader.cjs (reader ACL).
 * Usage from apps/ai-hero (run tsx directly for JSON-only output):
 * Dry run: tsx scripts/scope-interest-facts-dry-run.ts --reader /path/to/aihero-support/tmp/db/reader.cjs [--contacts /absolute/contacts.txt]
 * Apply:   tsx scripts/scope-interest-facts-dry-run.ts --reader /path/to/aihero-support/tmp/db/reader.cjs --contacts /absolute/contacts.txt --apply
 * Reuses DROVR_API_BASE_URL / DROVR_SHADOW_INGEST_URL and DROVR_API_KEY_ORG_AIHERO.
 * Emails are used only for resolve_contacts. Output is aggregate counts.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { resolveDrovrApiBaseUrl } from '../src/lib/subscriber-marketing/drovr-unsubscribe-page'
import {
	planScopeInterestFacts,
	selectScopeAnswerRows,
} from '../src/lib/subscriber-marketing/survey-interest-facts'

const Row = z.object({
	id: z.string().min(1),
	contactId: z.string().min(1),
	email: z.string().nullable(),
	occurredAt: z.string().datetime(),
	keywords: z.preprocess(
		(value) => (typeof value === 'string' ? JSON.parse(value) : value),
		z.array(z.string()),
	),
	contactClicks: z.coerce.number().int().nonnegative(),
	stepClicks: z.coerce.number().int().nonnegative(),
})

type ReaderConnection = {
	query(sql: string): Promise<[unknown, unknown]>
	end(): Promise<void>
}

type ScopeArgs = { reader: string } & (
	| { mode: 'dry-run'; contacts?: string }
	| { mode: 'apply'; contacts: string }
)

export function parseScopeArgs(argv: string[]): ScopeArgs | { error: string } {
	try {
		const { values, tokens } = parseArgs({
			args: argv,
			options: {
				reader: { type: 'string' },
				contacts: { type: 'string' },
				apply: { type: 'boolean' },
			},
			tokens: true,
		})
		if (tokens.length !== Object.keys(values).length)
			return { error: 'Pass each option only once.' }
		const { reader, contacts, apply } = values
		if (apply && !contacts)
			return {
				error: 'Use --apply --contacts /absolute/contacts.txt, or omit --apply for a dry run.',
			}
		if (contacts !== undefined && !isAbsolute(contacts))
			return { error: 'Use --contacts with an absolute path.' }
		if (
			!reader ||
			!isAbsolute(reader) ||
			!normalize(reader).endsWith('/aihero-support/tmp/db/reader.cjs')
		)
			return { error: 'Supply --reader /absolute/path/to/aihero-support/tmp/db/reader.cjs.' }
		return apply && contacts
			? { mode: 'apply', reader, contacts }
			: { mode: 'dry-run', reader, contacts }
	} catch {
		return { error: 'Use --reader with optional --contacts; --apply requires --contacts.' }
	}
}

async function readScopeRows(readerPath: string) {
	// The supplied, operator-owned factory leases only the PlanetScale reader.
	const reader: () => Promise<ReaderConnection> = createRequire(
		import.meta.url,
	)(readerPath)
	const database = await reader()
	let raw: unknown
	try {
		;[raw] = await database.query(`
			WITH answer_clicks AS (
				SELECT id, contactId, occurredAt, JSON_EXTRACT(payloadSummary, '$.keywords') AS keywords,
					COUNT(*) OVER (PARTITION BY contactId) AS contactClicks,
					SUM(JSON_CONTAINS(JSON_EXTRACT(payloadSummary, '$.keywords'), JSON_QUOTE('ai-hero-skills-workflow.email-0')))
						OVER (PARTITION BY contactId) AS stepClicks
				FROM AI_ContactEvent WHERE eventType = 'value-path.answer-selected'
			)
			SELECT e.id, e.contactId, c.email,
				DATE_FORMAT(e.occurredAt, '%Y-%m-%dT%H:%i:%s.000Z') AS occurredAt,
				e.keywords, e.contactClicks, e.stepClicks
			FROM answer_clicks e LEFT JOIN AI_Contact c ON c.id = e.contactId
			WHERE JSON_CONTAINS(e.keywords, JSON_QUOTE('ai-hero-skills-workflow.email-0'))
				AND (JSON_CONTAINS(e.keywords, JSON_QUOTE('personal'))
					OR JSON_CONTAINS(e.keywords, JSON_QUOTE('team'))
					OR JSON_CONTAINS(e.keywords, JSON_QUOTE('unsure')))
			ORDER BY e.occurredAt, e.id
		`)
	} finally {
		await database.end()
	}
	return z.array(Row).parse(raw)
}

async function run(argv: string[]) {
	const args = parseScopeArgs(argv)
	const { counts: emptyCounts } = planScopeInterestFacts({
		rows: [],
		resolved: new Map(),
	})
	let requestedContacts: number | null = null
	const report = {
		mode: 'mode' in args ? args.mode : argv.includes('--apply') ? 'apply' : 'dry-run',
		counts: emptyCounts,
		matchedContacts: 0,
		requestedWithNoScopeRow: 0,
		facts: 0,
		batches: 0,
		inserted: 0,
		duplicates: 0,
		conflicts: 0,
		databaseWrites: 0,
		factWrites: 0,
	}
	const aggregate = () => ({ ...report, requestedContacts, byRole: report.counts.byRole })
	if ('error' in args) return { ...aggregate(), error: args.error }

	let stage = 'contacts-file'
	try {
		const contacts = args.contacts === undefined
			? undefined
			: new Set(
					(await readFile(args.contacts, 'utf8'))
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean),
				)
		requestedContacts = contacts?.size ?? null

		stage = 'drovr-config'
		const baseUrl = resolveDrovrApiBaseUrl({
			DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
			DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
		})
		const apiKey = process.env.DROVR_API_KEY_ORG_AIHERO
		if (!baseUrl || !apiKey) return { ...aggregate(), error: 'Drovr is not configured.' }
		const config = { baseUrl, apiKey }

		stage = 'scope-row-read'
		const { rows, matchedContacts, requestedWithNoScopeRow } = selectScopeAnswerRows({
			rows: await readScopeRows(args.reader),
			contacts,
		})
		Object.assign(report, { matchedContacts, requestedWithNoScopeRow })
		stage = 'scope-fact-planning'
		const { resolveDrovrContacts } =
			await import('../src/lib/subscriber-marketing/drovr-purchase-resolve')
		const resolved = await resolveDrovrContacts({
			emails: rows.flatMap((row) => (row.email ? [row.email] : [])),
			config,
		})
		const { facts, counts } = planScopeInterestFacts({ rows, resolved })
		report.counts = counts
		report.facts = facts.length

		if (args.mode === 'apply' && facts.length > 0) {
			stage = 'fact-writer-load'
			const { recordScopeInterestFactBatches } =
				await import('../src/lib/subscriber-marketing/survey-interest-facts-live')
			const { failedBatch, ...readback } = await recordScopeInterestFactBatches({
				facts,
				config,
			})
			Object.assign(report, readback, { factWrites: readback.inserted })
			if (failedBatch !== null) {
				return {
					...aggregate(),
					failedBatch,
					error: 'Batch not acknowledged; counts cover only earlier batches. A re-run is safe because sourceId is immutable and firstWins is set.',
				}
			}
		}
		return aggregate()
	} catch {
		// Never print SQL, file paths or provider exception text.
		return { ...aggregate(), error: `Backfill stopped at ${stage}.` }
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	// This CLI checks its own drovr configuration. Don't load unrelated app
	// env validation (which logs on failure) when importing the shared clients.
	process.env.SKIP_ENV_VALIDATION = '1'
	const report = await run(process.argv.slice(2))
	console.log(JSON.stringify(report, null, 2))
	if ('error' in report) process.exitCode = 1
}
