import { courseBuilderAdapter } from '@/db'
import { CONTENT_RESOURCE_INDEX_REQUESTED_EVENT } from '@/inngest/events/content-resource-index'
import { inngest } from '@/inngest/inngest.server'
import { upsertPostToTypeSense } from '@/lib/typesense-query'
import { log } from '@/server/logger'
import { NonRetriableError } from 'inngest'

export const contentResourceIndexRequested = inngest.createFunction(
	{
		id: 'content-resource-index-requested',
		name: 'Content resource: reconcile current Typesense snapshot',
		concurrency: { key: 'event.data.resourceId', limit: 1 },
	},
	{ event: CONTENT_RESOURCE_INDEX_REQUESTED_EVENT },
	async ({ event, step }) => {
		const { resourceId, committedVersionId } = event.data

		const indexed = await step.run(
			'load-latest-current-resource-and-index',
			async () => {
				const latest = await courseBuilderAdapter.getContentResource(resourceId)
				if (!latest) {
					throw new NonRetriableError(`Resource not found: ${resourceId}`)
				}

				const result = await upsertPostToTypeSense(latest, 'save')
				if (!result.ok) {
					const message = `Typesense indexing failed for ${resourceId}: ${result.reason}`
					if (
						result.reason === 'config-missing' ||
						result.reason === 'invalid-resource'
					) {
						throw new NonRetriableError(message)
					}
					throw new Error(message)
				}

				return {
					resourceId,
					requestedVersionId: committedVersionId,
					indexedVersionId: latest.currentVersionId,
				}
			},
		)

		void log.info('content.resource.index.completed', indexed)
		return indexed
	},
)
