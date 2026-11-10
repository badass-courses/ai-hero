/** Dry run ONLY. No apply switch and no import of the fact writer.
 * Database reads must use aihero-support/tmp/db/reader.cjs (reader ACL).
 * Usage from apps/ai-hero:
 * SKIP_ENV_VALIDATION=1 tsx scripts/scope-interest-facts-dry-run.ts --reader /absolute/path/to/aihero-support/tmp/db/reader.cjs
 * Reuses DROVR_API_BASE_URL / DROVR_SHADOW_INGEST_URL and DROVR_API_KEY_ORG_AIHERO.
 * Emails exist only in memory for resolve_contacts. Output is aggregate counts.
 */
import { createRequire } from 'node:module'
import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'

import { resolveDrovrContacts } from '../src/lib/subscriber-marketing/drovr-purchase-resolve'
import { drovrApiKeyForTenant } from '../src/lib/subscriber-marketing/drovr-shadow-emitter'
import { resolveDrovrApiBaseUrl } from '../src/lib/subscriber-marketing/drovr-unsubscribe-page'
import { planScopeInterestFacts } from '../src/lib/subscriber-marketing/survey-interest-facts'

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

async function main() {
	const args = process.argv.slice(2)
	if (
		args.length !== 2 ||
		args[0] !== '--reader' ||
		!args[1] ||
		!isAbsolute(args[1]) ||
		!normalize(args[1]).endsWith('/aihero-support/tmp/db/reader.cjs')
	) {
		throw new Error('reader-argument-required; no apply mode exists')
	}
	const baseUrl = resolveDrovrApiBaseUrl({
		DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
		DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
	})
	const apiKey = drovrApiKeyForTenant('org-aihero', {
		authorityApiKey: process.env.DROVR_API_KEY_ORG_AIHERO,
	})
	if (!baseUrl || !apiKey) throw new Error('drovr-resolution-not-configured')
	// The supplied, operator-owned factory leases only the PlanetScale reader.
	const reader: () => Promise<ReaderConnection> = createRequire(
		import.meta.url,
	)(args[1])
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
	const rows = z.array(Row).parse(raw)
	const resolutions = await resolveDrovrContacts({
		emails: rows.flatMap((row) => (row.email ? [row.email] : [])),
		config: { baseUrl, apiKey },
	})
	const { facts, counts } = planScopeInterestFacts({
		rows,
		resolved: resolutions,
	})
	const sourceByRole = Object.fromEntries(
		['personal', 'team', 'unsure'].map((role) => [
			role,
			rows.filter((row) => row.keywords.includes(role)).length,
		]),
	)
	console.log(
		JSON.stringify(
			{
				mode: 'dry-run',
				tenantId: 'org-aihero',
				campaignId: 'contact-segments',
				...counts,
				sourceContacts: new Set(rows.map((row) => row.contactId)).size,
				sourceByRole,
				facts: facts.length,
				inferredContacts: new Set(facts.map((fact) => fact.contactId)).size,
				statedContacts: 0,
				unknownHistoricalProvenanceRows: facts.length,
				databaseWrites: 0,
				factWrites: 0,
			},
			null,
			2,
		),
	)
}
main().catch(() => {
	// Never print SQL/provider exception text: it can contain customer data.
	console.error('scope-interest-dry-run failed; no fact writes attempted')
	process.exitCode = 1
})
