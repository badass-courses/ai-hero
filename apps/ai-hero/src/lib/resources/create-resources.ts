'use server'

import { db, type DbExecutor } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { guid } from '@coursebuilder/utils/guid'
import slugify from '@sindresorhus/slugify'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

import { upsertPostToTypeSense } from '../typesense-query'

const NewResourceSchema = z.object({
	type: z.string(),
	title: z.string().min(2).max(90),
	description: z.string().optional(),
})

type NewResource = z.infer<typeof NewResourceSchema>

export async function executeResourceCreationSideEffects(resource: any) {
	try {
		await upsertPostToTypeSense(resource, 'save')
		await log.info('resource.typesense.indexed', {
			resourceId: resource.id,
			action: 'save',
		})
	} catch (error) {
		void log.error('resource.typesense.index.failed', {
			resourceId: resource.id,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export async function createResource(
	input: NewResource,
	options?: {
		tx?: DbExecutor
		deferSideEffects?: boolean
	},
) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	if (!user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const hash = guid()
	const newResourceId = slugify(`${input.type}~${hash}`)

	const newResource = {
		id: newResourceId,
		type: input.type,
		fields: {
			title: input.title,
			state: 'draft',
			visibility: 'unlisted',
			slug: slugify(`${input.title}~${hash}`),
			...(input.description?.trim()
				? { description: input.description.trim() }
				: {}),
		},
		createdById: user.id,
	}

	const dbContext = options?.tx || db
	await dbContext.insert(contentResource).values(newResource)

	const resource = await dbContext.query.contentResource.findFirst({
		where: eq(contentResource.id, newResourceId),
		with: {
			resources: {
				with: {
					resource: {
						with: {
							resources: {
								with: {
									resource: true,
								},
								orderBy: asc(contentResourceResource.position),
							},
						},
					},
				},
				orderBy: asc(contentResourceResource.position),
			},
		},
	})

	const parsedResource = ContentResourceSchema.safeParse(resource)
	if (!parsedResource.success) {
		void log.error('resource.parse.error', {
			resourceId: newResourceId,
			resourceType: input.type,
			error: parsedResource.error.message,
		})
		throw new Error('Error parsing resource')
	}

	if (!options?.deferSideEffects) {
		await executeResourceCreationSideEffects(parsedResource.data)
	}

	return parsedResource.data
}
