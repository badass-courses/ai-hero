import { revalidatePath, revalidateTag } from 'next/cache'
import { log } from '@/server/logger'
import type { ContentResource } from '@coursebuilder/core/schemas/content-resource-schema'

import type {
	EditorResourceEffectWarning,
	EditorResourceEffects,
	EditorResourceRecord,
} from './editor-resource'
import { upsertPostToTypeSense } from './typesense-query'

const MAX_RECONCILIATION_PASSES = 5

function asTypesenseResource(resource: EditorResourceRecord): ContentResource {
	const fields = resource.fields ?? {}
	return {
		id: resource.id,
		type: resource.type,
		createdById: resource.createdById,
		currentVersionId: resource.currentVersionId,
		fields,
		slug: typeof fields.slug === 'string' ? fields.slug : null,
		createdAt: resource.createdAt,
		updatedAt: resource.updatedAt,
		deletedAt: resource.deletedAt,
		resources: [],
		resourceProducts: [],
		organizationId: resource.organizationId,
		createdByOrganizationMembershipId:
			resource.createdByOrganizationMembershipId,
	}
}

function searchAction(
	previous: EditorResourceRecord,
	current: EditorResourceRecord,
) {
	return previous.fields?.state !== 'published' &&
		current.fields?.state === 'published'
		? 'publish'
		: 'save'
}

export const editorResourceEffects: EditorResourceEffects = {
	async afterWrite({
		action,
		previousResource,
		resource,
		userId,
		getCurrentResource,
	}) {
		const warnings: EditorResourceEffectWarning[] = []
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
			try {
				let previousIndexed = previousResource
				let candidate = resource
				let reconciled = false

				for (let pass = 1; pass <= MAX_RECONCILIATION_PASSES; pass++) {
					const result = await upsertPostToTypeSense(
						asTypesenseResource(candidate),
						searchAction(previousIndexed, candidate),
					)
					if (!result.ok) {
						warnings.push({
							effect: 'typesense',
							message: `Typesense reconciliation did not complete (${result.reason}).`,
						})
						break
					}

					const latest = await getCurrentResource()
					if (
						!latest ||
						latest.currentVersionId === candidate.currentVersionId
					) {
						reconciled = true
						break
					}

					await log.info('editor.resource.typesense.reconcile-stale', {
						resourceId: resource.id,
						indexedVersionId: candidate.currentVersionId,
						currentVersionId: latest.currentVersionId,
						pass,
						userId,
					})
					previousIndexed = candidate
					candidate = latest
				}

				if (
					!reconciled &&
					!warnings.some(({ effect }) => effect === 'typesense')
				) {
					warnings.push({
						effect: 'typesense',
						message:
							'Typesense reconciliation could not catch up with the current resource version.',
					})
				}
				if (reconciled) {
					await log.info('editor.resource.typesense.success', {
						resourceId: resource.id,
						versionId: candidate.currentVersionId,
						userId,
					})
				}
			} catch (error) {
				warnings.push({
					effect: 'typesense',
					message: 'Typesense reconciliation failed after the database commit.',
				})
				await log.warn('editor.resource.typesense.failed', {
					resourceId: resource.id,
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
			warnings.push({
				effect: 'cache',
				message: 'Cache invalidation failed after the database commit.',
			})
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
			changedFields,
			previousVersionId: previousResource.currentVersionId,
			versionId: resource.currentVersionId,
			userId,
			warnings,
		})
		return warnings
	},
}
