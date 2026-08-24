import { revalidatePath, revalidateTag } from 'next/cache'
import {
	CONTENT_RESOURCE_INDEX_REQUESTED_EVENT,
	contentResourceIndexEventId,
} from '@/inngest/events/content-resource-index'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'

import type {
	EditorResourceEffectResult,
	EditorResourceEffects,
} from './editor-resource'

export const editorResourceEffects: EditorResourceEffects = {
	async afterWrite({ action, previousResource, resource, userId }) {
		const warnings: EditorResourceEffectResult['warnings'] = []
		const effects: EditorResourceEffectResult['effects'] = {
			typesense: 'not-applicable',
			cache: 'completed',
		}
		const fields = resource.fields ?? {}
		const previousFields = previousResource.fields ?? {}
		const slug = typeof fields.slug === 'string' ? fields.slug : null
		const previousSlug =
			typeof previousFields.slug === 'string' ? previousFields.slug : null
		const changedFields = [
			...new Set([...Object.keys(previousFields), ...Object.keys(fields)]),
		]
			.filter(
				(key) =>
					JSON.stringify(previousFields[key]) !== JSON.stringify(fields[key]),
			)
			.sort()

		if (resource.type === 'workshop') {
			const committedVersionId = resource.currentVersionId
			if (!committedVersionId) {
				effects.typesense = 'degraded'
				warnings.push({
					effect: 'typesense',
					message:
						'Typesense indexing was not queued because the committed version ID is missing.',
				})
			} else {
				try {
					const eventId = contentResourceIndexEventId({
						resourceId: resource.id,
						committedVersionId,
					})
					const enqueued = await inngest.send({
						id: eventId,
						name: CONTENT_RESOURCE_INDEX_REQUESTED_EVENT,
						data: {
							resourceId: resource.id,
							committedVersionId,
						},
					})
					if (!enqueued.ids.length) {
						throw new Error('Inngest accepted no indexing event')
					}
					effects.typesense = 'queued'
					void log.info('editor.resource.typesense.queued', {
						resourceId: resource.id,
						versionId: committedVersionId,
						eventId,
						userId,
					})
				} catch (error) {
					effects.typesense = 'degraded'
					warnings.push({
						effect: 'typesense',
						message:
							'Typesense indexing could not be queued after the database commit.',
					})
					void log.warn('editor.resource.typesense.enqueue-failed', {
						resourceId: resource.id,
						versionId: committedVersionId,
						userId,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			}
		}

		try {
			if (resource.type === 'workshop') {
				revalidateTag('workshop', 'max')
				revalidateTag('workshops', 'max')
				revalidateTag(resource.id, 'max')
				revalidatePath('/workshops')
				for (const pathSlug of new Set([previousSlug, slug])) {
					if (pathSlug) revalidatePath(`/workshops/${pathSlug}`)
				}
			} else if (resource.type === 'page') {
				revalidateTag('pages', 'max')
				for (const pathSlug of new Set([previousSlug, slug])) {
					if (pathSlug) revalidatePath(`/${pathSlug}`)
				}
			}
		} catch (error) {
			effects.cache = 'degraded'
			warnings.push({
				effect: 'cache',
				message: 'Cache invalidation failed after the database commit.',
			})
			void log.warn('editor.resource.cache-invalidation.failed', {
				resourceId: resource.id,
				userId,
				error: error instanceof Error ? error.message : String(error),
			})
		}

		void log.info('editor.resource.write.completed', {
			resourceId: resource.id,
			resourceType: resource.type,
			action,
			changedFields,
			previousVersionId: previousResource.currentVersionId,
			versionId: resource.currentVersionId,
			userId,
			effects,
			warnings,
		})
		return { effects, warnings }
	},
}
