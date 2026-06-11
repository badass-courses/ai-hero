export const AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT =
	'ai-coding-dictionary/source.changed' as const

export type AiCodingDictionarySourceChanged = {
	name: typeof AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT
	data: {
		repositoryFullName?: string
		ref?: string
		after?: string
		deliveryId?: string
		source: 'github-webhook' | 'manual' | 'build-time' | 'revalidate'
	}
}
