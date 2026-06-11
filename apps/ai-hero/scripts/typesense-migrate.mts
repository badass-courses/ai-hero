import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue }

type TypesenseField = {
	name: string
	type: string
	facet?: boolean
	optional?: boolean
	sort?: boolean
	index?: boolean
	store?: boolean
}

type CollectionSchema = {
	name: string
	enable_nested_fields?: boolean
	default_sorting_field?: string
	fields: TypesenseField[]
}

type SearchHit = {
	document: Record<string, JsonValue>
}

type SearchResponse = {
	found: number
	out_of?: number
	hits?: SearchHit[]
}

const args = new Set(process.argv.slice(2))
const shouldApply = args.has('--apply')
const shouldSwapAlias = args.has('--swap-alias')
const shouldDeleteCandidate = args.has('--delete-candidate')
const sourceCollection =
	readArg('--source') ||
	process.env.TYPESENSE_COLLECTION_NAME ||
	process.env.NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME ||
	'content_production'
const aliasName = readArg('--alias') || sourceCollection
const stamp = new Date()
	.toISOString()
	.replace(/[-:.TZ]/g, '')
	.slice(0, 14)
const targetCollection =
	readArg('--target') || `${sourceCollection}_v29_${stamp}`
const backupCollection =
	readArg('--backup') || `${sourceCollection}_backup_${stamp}`
const exportPath =
	readArg('--export-path') ||
	path.join(os.tmpdir(), `${sourceCollection}_${stamp}.ndjson`)

function readArg(name: string) {
	const withEquals = process.argv.find((arg) => arg.startsWith(`${name}=`))
	if (withEquals) return withEquals.slice(name.length + 1)
	const index = process.argv.indexOf(name)
	if (index >= 0) return process.argv[index + 1]
	return undefined
}

function requireEnv(name: string) {
	const value = process.env[name]
	if (!value) throw new Error(`Missing ${name}`)
	return value
}

function getTypesenseBaseUrl() {
	const host = requireEnv('NEXT_PUBLIC_TYPESENSE_HOST')
	const protocol = process.env.NEXT_PUBLIC_TYPESENSE_PROTOCOL || 'https'
	const port = process.env.NEXT_PUBLIC_TYPESENSE_PORT || '443'
	const hasDefaultPort =
		(protocol === 'https' && port === '443') ||
		(protocol === 'http' && port === '80')
	return `${protocol}://${host}${hasDefaultPort ? '' : `:${port}`}`
}

const apiKey = requireEnv('TYPESENSE_WRITE_API_KEY')
const baseUrl = getTypesenseBaseUrl()

async function typesenseRequest<T>(
	pathname: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			'X-TYPESENSE-API-KEY': apiKey,
			'Content-Type': 'application/json',
			...init.headers,
		},
	})
	const text = await response.text()
	const body = parseMaybeJson(text)

	if (!response.ok) {
		throw new Error(
			`${init.method || 'GET'} ${pathname} failed (${response.status}): ${
				typeof body === 'string' ? body : JSON.stringify(body)
			}`,
		)
	}

	return body as T
}

function parseMaybeJson(text: string) {
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function parseNdjson(ndjson: string) {
	return ndjson
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, JsonValue>)
}

function toNdjson(documents: Record<string, JsonValue>[]) {
	return documents.map((doc) => JSON.stringify(doc)).join('\n')
}

function hasField(documents: Record<string, JsonValue>[], field: string) {
	return documents.some(
		(doc) => doc[field] !== undefined && doc[field] !== null,
	)
}

function collectionSchema(
	name: string,
	documents: Record<string, JsonValue>[],
) {
	const fields: TypesenseField[] = [
		{ name: 'title', type: 'string' },
		{ name: 'slug', type: 'string' },
		{ name: 'description', type: 'string', optional: true },
		{ name: 'summary', type: 'string', optional: true },
		{ name: 'image', type: 'string', optional: true },
		{ name: 'visibility', type: 'string', facet: true },
		{ name: 'state', type: 'string', facet: true },
		{ name: 'type', type: 'string', facet: true },
		{
			name: 'published_at_timestamp',
			type: 'int64',
			optional: true,
			sort: true,
		},
		{ name: 'updated_at_timestamp', type: 'int64', sort: true },
		{ name: 'created_at_timestamp', type: 'int64', optional: true, sort: true },
	]

	if (hasField(documents, 'productType')) {
		fields.push({
			name: 'productType',
			type: 'string',
			facet: true,
			optional: true,
		})
	}

	if (hasField(documents, 'startsAt')) {
		fields.push({ name: 'startsAt', type: 'string', optional: true })
	}

	if (hasField(documents, 'endsAt')) {
		fields.push({ name: 'endsAt', type: 'string', optional: true })
	}

	if (hasField(documents, 'tags')) {
		fields.push(
			{ name: 'tags', type: 'object[]', facet: true, optional: true },
			{
				name: 'tags.fields.label',
				type: 'string[]',
				facet: true,
				optional: true,
			},
			{
				name: 'tags.fields.slug',
				type: 'string[]',
				facet: true,
				optional: true,
			},
			{
				name: 'tags.fields.name',
				type: 'string[]',
				facet: true,
				optional: true,
			},
			{ name: 'tags.id', type: 'string[]', facet: true, optional: true },
			{ name: 'tags.type', type: 'string[]', facet: true, optional: true },
		)
	}

	if (hasField(documents, 'parentResources')) {
		fields.push({ name: 'parentResources', type: 'object[]', optional: true })
	}

	fields.push({ name: '.*', type: 'auto', optional: true })

	return {
		name,
		enable_nested_fields: true,
		default_sorting_field: 'updated_at_timestamp',
		fields,
	} satisfies CollectionSchema
}

async function collectionExists(name: string) {
	try {
		await typesenseRequest(`/collections/${name}`)
		return true
	} catch (error) {
		if (String(error).includes('(404)')) return false
		throw error
	}
}

async function createCollection(
	name: string,
	documents: Record<string, JsonValue>[],
) {
	if (await collectionExists(name)) {
		throw new Error(`Collection already exists: ${name}`)
	}
	await typesenseRequest('/collections', {
		method: 'POST',
		body: JSON.stringify(collectionSchema(name, documents)),
	})
}

async function importDocuments(
	collectionName: string,
	documents: Record<string, JsonValue>[],
) {
	const result = await typesenseRequest<string>(
		`/collections/${collectionName}/documents/import?action=upsert`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: toNdjson(documents),
		},
	)
	const rows = result
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { success: boolean; error?: string })
	const failures = rows.filter((row) => !row.success)
	if (failures.length > 0) {
		throw new Error(
			`Import failed for ${failures.length} document(s): ${JSON.stringify(
				failures.slice(0, 5),
			)}`,
		)
	}
	return rows.length
}

async function search(collectionName: string, filterBy?: string, q = '*') {
	const params = new URLSearchParams({
		q,
		query_by: 'title,description,summary',
		per_page: '50',
		include_fields: 'id,title,type,state,visibility',
	})
	if (filterBy) params.set('filter_by', filterBy)
	return typesenseRequest<SearchResponse>(
		`/collections/${collectionName}/documents/search?${params.toString()}`,
	)
}

async function validateCollection(
	collectionName: string,
	documents: Record<string, JsonValue>[],
) {
	const exported = await typesenseRequest<string>(
		`/collections/${collectionName}/documents/export`,
	)
	const exportedCount = parseNdjson(exported).length
	const searchAll = await search(collectionName)
	const publicPublished = await search(
		collectionName,
		'visibility:=public && state:=published',
	)
	const sample = documents.find(
		(doc) =>
			doc.visibility === 'public' &&
			doc.state === 'published' &&
			typeof doc.title === 'string' &&
			doc.title.length > 0,
	)
	const sampleSearch =
		sample && typeof sample.title === 'string'
			? await search(collectionName, undefined, sample.title.split(' ')[0])
			: null

	return {
		exportedCount,
		searchFound: searchAll.found,
		searchOutOf: searchAll.out_of,
		publicPublishedFound: publicPublished.found,
		publicPublishedIds:
			publicPublished.hits?.map((hit) => hit.document.id).filter(Boolean) ?? [],
		sample: sample
			? {
					id: sample.id,
					title: sample.title,
					found: sampleSearch?.found ?? 0,
				}
			: null,
	}
}

async function upsertAlias(alias: string, collectionName: string) {
	await typesenseRequest(`/aliases/${alias}`, {
		method: 'PUT',
		body: JSON.stringify({ collection_name: collectionName }),
	})
}

async function main() {
	console.log(
		JSON.stringify(
			{
				mode: shouldApply ? 'apply' : 'dry-run',
				sourceCollection,
				targetCollection,
				backupCollection,
				aliasName,
				shouldSwapAlias,
				exportPath,
			},
			null,
			2,
		),
	)

	const exported = await typesenseRequest<string>(
		`/collections/${sourceCollection}/documents/export`,
	)
	const documents = parseNdjson(exported)
	if (documents.length === 0) {
		throw new Error(`Refusing to migrate empty collection: ${sourceCollection}`)
	}

	fs.writeFileSync(exportPath, exported)
	console.log(`Exported ${documents.length} docs to ${exportPath}`)

	const sourceValidation = await validateCollection(sourceCollection, documents)
	console.log('Source validation:')
	console.log(JSON.stringify(sourceValidation, null, 2))

	if (!shouldApply) {
		console.log('Dry run complete. Re-run with --apply to create collections.')
		return
	}

	await createCollection(backupCollection, documents)
	const backupImportCount = await importDocuments(backupCollection, documents)
	console.log(
		`Backup imported ${backupImportCount} docs into ${backupCollection}`,
	)

	await createCollection(targetCollection, documents)
	const targetImportCount = await importDocuments(targetCollection, documents)
	console.log(
		`Target imported ${targetImportCount} docs into ${targetCollection}`,
	)

	const targetValidation = await validateCollection(targetCollection, documents)
	console.log('Target validation:')
	console.log(JSON.stringify(targetValidation, null, 2))

	if (targetValidation.exportedCount !== documents.length) {
		throw new Error('Target export count does not match source export count')
	}
	if (targetValidation.searchFound < sourceValidation.searchFound) {
		throw new Error('Target search count is lower than source search count')
	}
	if (
		targetValidation.publicPublishedFound <
		sourceValidation.publicPublishedFound
	) {
		throw new Error('Target public/published count is lower than source')
	}

	if (shouldSwapAlias) {
		await upsertAlias(aliasName, targetCollection)
		console.log(`Alias ${aliasName} now points at ${targetCollection}`)
	} else {
		console.log(
			'Alias not swapped. Re-run with --apply --swap-alias to cut over.',
		)
	}

	if (shouldDeleteCandidate) {
		await typesenseRequest(`/collections/${targetCollection}`, {
			method: 'DELETE',
		})
		console.log(`Deleted candidate collection ${targetCollection}`)
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
