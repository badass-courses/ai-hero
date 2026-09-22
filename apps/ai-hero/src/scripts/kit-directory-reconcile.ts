import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, asc, eq, gt } from 'drizzle-orm'

import { readKitDirectoryPages } from './kit-directory-ingest'

const D1_DATABASE_ID = '942f3bca-e6e7-41e6-a3bb-7cbbe7c0967d'
const D1_PAGE_SIZE = 5_000
const PROVIDER_IDENTITY_PAGE_SIZE = 5_000
const OUTPUT_DIRECTORY = '/tmp/reconcile'
const MISSING_IDENTITIES_PATH = `${OUTPUT_DIRECTORY}/missing-identities.json`
const MISSING_DIRECTORY_PATH = `${OUTPUT_DIRECTORY}/missing-directory.json`
const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 3

type ProviderIdentityRow = {
	externalId: string
	contactId: string
}

type D1QueryResponse = {
	success?: unknown
	result?: unknown
	errors?: unknown
}

type D1QueryResult = {
	success?: unknown
	results?: unknown
}

export type ReconciliationResult = {
	missingIdentities: string[]
	missingDirectory: string[]
	counts: {
		kitIdentities: number
		providerIdentities: number
		directoryContacts: number
		missingIdentities: number
		missingDirectory: number
		missingIdentitiesByStatus: Record<string, number>
	}
}

function requiredEnvironment(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`${name} is required`)
	return value
}

function normalizedStatus(value: string | undefined) {
	return value?.trim() || 'unknown'
}

function addKitIdentity(
	statuses: Map<string, string>,
	id: string,
	status: string | undefined,
) {
	const normalizedId = id.trim()
	if (!normalizedId) return
	const nextStatus = normalizedStatus(status)
	const previousStatus = statuses.get(normalizedId)
	statuses.set(
		normalizedId,
		previousStatus && previousStatus !== nextStatus ? 'multiple' : nextStatus,
	)
}

export function reconcileIdentitySets(args: {
	kitStatuses: ReadonlyMap<string, string>
	providerIdentities: readonly ProviderIdentityRow[]
	directoryContacts: ReadonlySet<string>
}): ReconciliationResult {
	const providerKitIds = new Set(
		args.providerIdentities.map(({ externalId }) => externalId),
	)
	const providerContactIds = new Set(
		args.providerIdentities.map(({ contactId }) => contactId),
	)
	const missingIdentities = [...args.kitStatuses.keys()]
		.filter((id) => !providerKitIds.has(id))
		.sort()
	const missingDirectory = [...providerContactIds]
		.filter((contactId) => !args.directoryContacts.has(contactId))
		.sort()
	const missingIdentitiesByStatus: Record<string, number> = {}
	for (const id of missingIdentities) {
		const status = args.kitStatuses.get(id) ?? 'unknown'
		missingIdentitiesByStatus[status] =
			(missingIdentitiesByStatus[status] ?? 0) + 1
	}

	return {
		missingIdentities,
		missingDirectory,
		counts: {
			kitIdentities: args.kitStatuses.size,
			providerIdentities: args.providerIdentities.length,
			directoryContacts: args.directoryContacts.size,
			missingIdentities: missingIdentities.length,
			missingDirectory: missingDirectory.length,
			missingIdentitiesByStatus: Object.fromEntries(
				Object.entries(missingIdentitiesByStatus).sort(([left], [right]) =>
					left.localeCompare(right),
				),
			),
		},
	}
}

async function readKitIdentities(
	accounts: readonly { brand: string; env: string; apiKey: string }[],
) {
	const statuses = new Map<string, string>()
	const sourceCounts: Record<string, number> = {}
	for (const account of accounts) {
		let pages = 0
		let rows = 0
		for await (const page of readKitDirectoryPages({
			apiKey: account.apiKey,
			status: 'all',
		})) {
			pages += 1
			rows += page.subscribers.length
			for (const subscriber of page.subscribers) {
				addKitIdentity(statuses, subscriber.id, subscriber.state)
			}
			if (pages % 25 === 0) {
				console.log(
					`kit-directory-reconcile source=${account.brand} pages=${pages} rows=${rows}`,
				)
			}
		}
		sourceCounts[account.brand] = rows
		console.log(
			`kit-directory-reconcile source=${account.brand} complete pages=${pages} rows=${rows}`,
		)
	}
	return { sourceCounts, statuses }
}

async function readProviderIdentities(): Promise<ProviderIdentityRow[]> {
	const [databaseModule, schema] = await Promise.all([
		import('@/db'),
		import('@/db/schema'),
	])
	const rows: ProviderIdentityRow[] = []
	let after: string | undefined
	try {
		for (;;) {
			const page = await databaseModule.db
				.select({
					externalId: schema.providerIdentity.externalId,
					contactId: schema.providerIdentity.contactId,
				})
				.from(schema.providerIdentity)
				.where(
					after
						? and(
								eq(schema.providerIdentity.provider, 'kit'),
								gt(schema.providerIdentity.externalId, after),
							)
						: eq(schema.providerIdentity.provider, 'kit'),
				)
				.orderBy(asc(schema.providerIdentity.externalId))
				.limit(PROVIDER_IDENTITY_PAGE_SIZE)
			rows.push(...page)
			if (page.length < PROVIDER_IDENTITY_PAGE_SIZE) break
			const nextAfter = page.at(-1)?.externalId
			if (!nextAfter || nextAfter === after) {
				throw new Error('Provider identity pagination did not advance')
			}
			after = nextAfter
		}
		return rows
	} finally {
		await databaseModule.closeDatabasePool()
	}
}

async function fetchD1Page(args: {
	accountId: string
	apiToken: string
	after: string
}) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(args.accountId)}/d1/database/${D1_DATABASE_ID}/query`
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${args.apiToken}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					sql: `select distinct contact_id from drovr_receipts where tenant_id = ? and journey_id = ? and contact_id > ? order by contact_id limit ${D1_PAGE_SIZE}`,
					params: ['org-aihero', 'contact-directory', args.after],
				}),
				signal: controller.signal,
			})
			const payload = (await response.json()) as D1QueryResponse
			if (!response.ok || payload.success !== true) {
				throw new Error(`D1 query failed with HTTP ${response.status}`)
			}
			const firstResult = Array.isArray(payload.result)
				? (payload.result[0] as D1QueryResult | undefined)
				: undefined
			if (!firstResult || firstResult.success !== true) {
				throw new Error('D1 query returned an unsuccessful result')
			}
			if (!Array.isArray(firstResult.results)) {
				throw new Error('D1 query returned invalid rows')
			}
			return firstResult.results.map((row) => {
				if (
					typeof row !== 'object' ||
					row === null ||
					!('contact_id' in row) ||
					typeof row.contact_id !== 'string'
				) {
					throw new Error('D1 query returned an invalid contact id')
				}
				return row.contact_id
			})
		} catch (error) {
			if (attempt === MAX_ATTEMPTS) throw error
			await new Promise((resolveSleep) =>
				setTimeout(resolveSleep, 1_000 * 2 ** (attempt - 1)),
			)
		} finally {
			clearTimeout(timeout)
		}
	}
	throw new Error('D1 query retry loop exhausted')
}

async function readDirectoryContacts(args: {
	accountId: string
	apiToken: string
}) {
	const contacts = new Set<string>()
	let after = ''
	for (;;) {
		const page = await fetchD1Page({ ...args, after })
		for (const contactId of page) contacts.add(contactId)
		if (page.length < D1_PAGE_SIZE) return contacts
		const nextAfter = page.at(-1)
		if (!nextAfter || nextAfter === after) {
			throw new Error('D1 contact pagination did not advance')
		}
		after = nextAfter
	}
}

async function writeJson(path: string, value: unknown) {
	const target = resolve(path)
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
	await mkdir(dirname(target), { recursive: true })
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		})
		await rename(temporary, target)
	} finally {
		await rm(temporary, { force: true })
	}
}

async function main() {
	const cutoff = new Date().toISOString()
	// The legacy TT v3 credentials address this same account; the v4 key is the
	// only credential here that can enumerate all subscriber states.
	const kitAccounts = [
		{
			brand: 'ai-hero+total-typescript',
			env: 'CONVERTKIT_V4_API_KEY',
			apiKey: requiredEnvironment('CONVERTKIT_V4_API_KEY'),
		},
	] as const
	const [kit, providerIdentities, directoryContacts] = await Promise.all([
		readKitIdentities(kitAccounts),
		readProviderIdentities(),
		readDirectoryContacts({
			accountId: requiredEnvironment('CLOUDFLARE_ACCOUNT_ID'),
			apiToken: requiredEnvironment('CLOUDFLARE_API_TOKEN'),
		}),
	])
	const result = reconcileIdentitySets({
		kitStatuses: kit.statuses,
		providerIdentities,
		directoryContacts,
	})

	await Promise.all([
		writeJson(MISSING_IDENTITIES_PATH, result.missingIdentities),
		writeJson(MISSING_DIRECTORY_PATH, result.missingDirectory),
	])
	console.log(
		JSON.stringify({
			cutoff,
			kitSources: kitAccounts.map(({ brand, env }) => ({ brand, env })),
			kitRowsBySource: kit.sourceCounts,
			counts: result.counts,
			outputs: {
				missingIdentities: MISSING_IDENTITIES_PATH,
				missingDirectory: MISSING_DIRECTORY_PATH,
			},
		}),
	)
}

const invokedPath = process.argv[1]
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : 'Unknown error')
		process.exitCode = 1
	})
}
