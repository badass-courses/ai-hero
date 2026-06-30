'use server'

import { revalidatePath, revalidateTag } from 'next/cache'
import { courseBuilderAdapter } from '@/db'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { triggerCohortEntitlementSync } from './cohort-update-trigger'
import { upsertPostToTypeSense } from './typesense-query'

export async function updateResource(input: {
	id: string
	type: string
	fields: Record<string, any>
	createdById: string
}) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('update', 'Content')) {
		await log.error('resource.update.unauthorized', {
			resourceId: input.id,
			userId: user?.id,
		})
		throw new Error('Unauthorized')
	}

	const currentResource = await courseBuilderAdapter.getContentResource(
		input.id,
	)

	if (!currentResource) {
		await log.info('resource.create.started', {
			resourceId: input.id,
			type: input.type,
			userId: user.id,
		})

		const newResource = await courseBuilderAdapter.createContentResource(input)

		if (newResource) {
			try {
				await upsertPostToTypeSense(newResource, 'save')
				await log.info('resource.typesense.indexed', {
					resourceId: newResource.id,
					action: 'save',
				})
			} catch (error) {
				await log.error('resource.typesense.index.failed', {
					error: getErrorMessage(error),
					resourceId: newResource.id,
				})
			}

			const newSlug = newResource.fields?.slug
			if (newSlug) {
				revalidatePath(getResourcePath(input.type, newSlug))
			}
			revalidateTag(input.type, 'max')
		}

		return newResource
	}

	// Slugs are intentionally NOT regenerated when the title changes — only an
	// explicit edit to the slug field changes the slug.
	const resourceSlug = input.fields.slug ?? currentResource?.fields?.slug

	const updatedResource =
		await courseBuilderAdapter.updateContentResourceFields({
			id: currentResource.id,
			fields: {
				...currentResource.fields,
				...input.fields,
				slug: resourceSlug,
				...(input.fields.image && {
					image: input.fields.image,
				}),
			},
		})

	if (updatedResource) {
		try {
			await upsertPostToTypeSense(updatedResource, 'save')
			await log.info('resource.update.typesense.success', {
				resourceId: input.id,
				action: 'save',
				userId: user.id,
			})
		} catch (error) {
			await log.error('resource.update.typesense.failed', {
				resourceId: input.id,
				error: getErrorMessage(error),
				userId: user.id,
			})
		}
	}

	await log.info('resource.update.success', {
		resourceId: input.id,
		userId: user.id,
		changes: Object.keys(input.fields),
	})

	const slugForPath = updatedResource?.fields?.slug ?? resourceSlug
	if (slugForPath) {
		revalidatePath(getResourcePath(input.type, slugForPath))
	}
	revalidateTag(input.type, 'max')

	// Trigger entitlement sync for cohorts
	if (input.type === 'cohort') {
		try {
			await triggerCohortEntitlementSync(input.id, {})
		} catch (error) {
			await log.error('cohort.entitlement_sync.trigger_failed', {
				cohortId: input.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return updatedResource
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}
