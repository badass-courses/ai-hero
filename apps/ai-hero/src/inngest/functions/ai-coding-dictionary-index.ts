import { revalidateTag } from 'next/cache'
import { indexAiCodingDictionaryToTypesense } from '@/lib/ai-coding-dictionary-typesense'

import { AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT } from '../events/ai-coding-dictionary'
import { inngest } from '../inngest.server'

export const aiCodingDictionaryIndex = inngest.createFunction(
	{
		id: 'ai-coding-dictionary-index',
		name: 'AI Coding Dictionary Typesense Index',
		concurrency: { limit: 1 },
	},
	{ event: AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT },
	async ({ event, step }) => {
		await step.run('revalidate dictionary cache', async () => {
			revalidateTag('ai-coding-dictionary', 'max')
			return { revalidated: true }
		})

		const result = await step.run('index dictionary to typesense', async () => {
			return indexAiCodingDictionaryToTypesense({ deleteFirst: true })
		})

		return {
			...result,
			source: event.data.source,
			deliveryId: event.data.deliveryId,
		}
	},
)
