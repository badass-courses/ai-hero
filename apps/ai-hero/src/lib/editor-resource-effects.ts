import { revalidatePath, revalidateTag } from 'next/cache'
import { log } from '@/server/logger'
import type { ContentResource } from '@coursebuilder/core/schemas/content-resource-schema'

import type { EditorResourceEffects } from './editor-resource'
import { upsertPostToTypeSense } from './typesense-query'

export const editorResourceEffects: EditorResourceEffects = {
	async afterWrite({ action, previousResource, resource, userId }) {
		const fields = resource.fields ?? {}
		const previousFields = previousResource.fields ?? {}
		const slug = typeof fields.slug === 'string' ? fields.slug : null
		const previousSlug =
			typeof previousFields.slug === 'string' ? previousFields.slug : null
		const searchAction =
			action === 'publish' ||
			(action === 'rollback' &&
				previousFields.state !== 'published' &&
				fields.state === 'published')
				? 'publish'
				: 'save'

		if (resource.type === 'workshop') {
			try {
				const typesenseResource: ContentResource = {
					id: resource.id,
					type: resource.type,
					createdById: resource.createdById,
					currentVersionId: resource.currentVersionId,
					fields,
					slug,
					createdAt: resource.createdAt,
					updatedAt: resource.updatedAt,
					deletedAt: resource.deletedAt,
					resources: [],
					resourceProducts: [],
					organizationId: resource.organizationId,
					createdByOrganizationMembershipId:
						resource.createdByOrganizationMembershipId,
				}
				await upsertPostToTypeSense(typesenseResource, searchAction)
				await log.info('editor.resource.typesense.success', {
					resourceId: resource.id,
					action: searchAction,
					userId,
				})
			} catch (error) {
				await log.warn('editor.resource.typesense.failed', {
					resourceId: resource.id,
					action: searchAction,
					userId,
					error: error instanceof Error ? error.message : String(error),
				})
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
			await log.warn('editor.resource.cache-invalidation.failed', {
				resourceId: resource.id,
				userId,
				error: error instanceof Error ? error.message : String(error),
			})
		}

		await log.info('editor.resource.write.completed', {
			resourceId: resource.id,
			resourceType: resource.type,
			action,
			versionId: resource.currentVersionId,
			userId,
		})
	},
}
