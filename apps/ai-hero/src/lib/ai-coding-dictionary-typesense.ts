import { log } from '@/server/logger'
import { TYPESENSE_COLLECTION_NAME } from '@/utils/typesense-instantsearch-adapter'
import Typesense from 'typesense'

import {
	AI_CODING_DICTIONARY_DESCRIPTION,
	AI_CODING_DICTIONARY_TITLE,
	getAiCodingDictionary,
	stripMarkdown,
	type DictionaryData,
} from './ai-coding-dictionary'
import { TypesenseResourceSchema, type TypesenseResource } from './typesense'

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function createTypesenseWriteClient() {
	if (
		!process.env.TYPESENSE_WRITE_API_KEY ||
		!process.env.NEXT_PUBLIC_TYPESENSE_HOST
	) {
		return null
	}

	return new Typesense.Client({
		nodes: [
			{
				host: process.env.NEXT_PUBLIC_TYPESENSE_HOST,
				port: 443,
				protocol: 'https',
			},
		],
		apiKey: process.env.TYPESENSE_WRITE_API_KEY,
		connectionTimeoutSeconds: 2,
	})
}

function dictionaryTimestamp(dictionary: DictionaryData) {
	return new Date(dictionary.updatedAt).getTime() || Date.now()
}

function entryDescription(entry: DictionaryData['entries'][number]) {
	const aliases = entry.aliases?.length
		? `\n\nAliases: ${entry.aliases.join(', ')}`
		: ''

	return stripMarkdown(`${entry.rawBody}${aliases}`)
}

export function getAiCodingDictionaryTypesenseDocuments(
	dictionary: DictionaryData,
) {
	const timestamp = dictionaryTimestamp(dictionary)
	const indexDescription = dictionary.sections
		.map((section) => {
			const entries = section.entries
				.map((entry) => `${entry.title}: ${entry.description}`)
				.join('\n')
			return `${section.title}\n${entries}`
		})
		.join('\n\n')

	const documents = [
		{
			id: 'ai-coding-dictionary',
			title: AI_CODING_DICTIONARY_TITLE,
			slug: 'ai-coding-dictionary',
			state: 'published',
			visibility: 'public',
			type: 'dictionary',
			summary: AI_CODING_DICTIONARY_DESCRIPTION,
			description: indexDescription,
			created_at_timestamp: timestamp,
			updated_at_timestamp: timestamp,
			published_at_timestamp: timestamp,
		},
		...dictionary.entries.map((entry) => ({
			id: `ai-coding-dictionary:${entry.slug}`,
			title: entry.title,
			slug: entry.slug,
			state: 'published',
			visibility: 'public',
			type: 'dictionary-entry',
			summary: entry.description,
			description: entryDescription(entry),
			created_at_timestamp: timestamp,
			updated_at_timestamp: timestamp,
			published_at_timestamp: timestamp,
		})),
	]

	return documents
		.map((document) => {
			const parsed = TypesenseResourceSchema.safeParse(document)

			if (!parsed.success) {
				void log.error('ai-coding-dictionary.typesense.document.invalid', {
					documentId: document.id,
					error: parsed.error.message,
				})
				return null
			}

			return parsed.data
		})
		.filter((document): document is TypesenseResource => document !== null)
}

export async function indexAiCodingDictionaryToTypesense({
	deleteFirst = true,
}: {
	deleteFirst?: boolean
} = {}) {
	const client = createTypesenseWriteClient()

	if (!client) {
		void log.warn('ai-coding-dictionary.typesense.config-missing', {
			hasHost: !!process.env.NEXT_PUBLIC_TYPESENSE_HOST,
			hasWriteKey: !!process.env.TYPESENSE_WRITE_API_KEY,
			collection: TYPESENSE_COLLECTION_NAME,
		})
		return { documentCount: 0, skipped: true }
	}

	const dictionary = await getAiCodingDictionary()
	const documents = getAiCodingDictionaryTypesenseDocuments(dictionary)

	if (deleteFirst) {
		await client
			.collections(TYPESENSE_COLLECTION_NAME)
			.documents()
			.delete({ filter_by: 'type:=[dictionary,dictionary-entry]' })
			.catch((error: unknown) => {
				void log.warn('ai-coding-dictionary.typesense.delete.failed', {
					collection: TYPESENSE_COLLECTION_NAME,
					error: getErrorMessage(error),
				})
			})
	}

	if (documents.length === 0) {
		void log.warn('ai-coding-dictionary.typesense.empty', {
			collection: TYPESENSE_COLLECTION_NAME,
		})
		return { documentCount: 0, skipped: false }
	}

	await client
		.collections(TYPESENSE_COLLECTION_NAME)
		.documents()
		.import(documents, { action: 'upsert' })

	void log.info('ai-coding-dictionary.typesense.indexed', {
		collection: TYPESENSE_COLLECTION_NAME,
		documentCount: documents.length,
	})

	return { documentCount: documents.length, skipped: false }
}
