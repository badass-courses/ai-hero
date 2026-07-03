'use server'

import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { IMAGE_RESOURCE_CREATED_EVENT } from '@/inngest/events/image-resource-created'
import { inngest } from '@/inngest/inngest.server'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

const ImageResourceSchema = z.object({
	id: z.string(),
	url: z.string(),
	alt: z.string().optional().nullable(),
	// Cloudinary metadata — absent on rows created before it was stored.
	width: z.coerce.number().optional().nullable(),
	height: z.coerce.number().optional().nullable(),
	bytes: z.coerce.number().optional().nullable(),
	format: z.string().optional().nullable(),
	// Row creation time — the media tab's unified grid sorts by it.
	createdAt: z.coerce.date().optional().nullable(),
})

export async function createImageResource(input: {
	asset_id: string
	secure_url: string
	width?: number
	height?: number
	bytes?: number
	format?: string
}) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	await db
		.insert(contentResource)
		.values({
			id: input.asset_id,
			type: 'imageResource',
			fields: {
				state: 'ready',
				url: input.secure_url,
				...(input.width ? { width: input.width } : {}),
				...(input.height ? { height: input.height } : {}),
				...(input.bytes ? { bytes: input.bytes } : {}),
				...(input.format ? { format: input.format } : {}),
			},
			createdById: user.id,
		})
		.then((result) => {
			return result
		})
		.catch((error) => {
			void log.error('image.create.error', {
				imageId: input.asset_id,
				createdById: user.id,
				error: error instanceof Error ? error.message : String(error),
			})
			throw error
		})

	await inngest.send({
		name: IMAGE_RESOURCE_CREATED_EVENT,
		data: {
			resourceId: input.asset_id,
		},
		user,
	})
}

export async function getAllImageResources() {
	const query = sql`
      SELECT    
        id as id,
        JSON_EXTRACT (${contentResource.fields}, "$.url") AS url,
        JSON_EXTRACT (${contentResource.fields}, "$.alt") AS alt,
        JSON_EXTRACT (${contentResource.fields}, "$.width") AS width,
        JSON_EXTRACT (${contentResource.fields}, "$.height") AS height,
        JSON_EXTRACT (${contentResource.fields}, "$.bytes") AS bytes,
        JSON_EXTRACT (${contentResource.fields}, "$.format") AS format,
        createdAt as createdAt
      FROM
        ${contentResource}
      WHERE
        type = 'imageResource'
      ORDER BY
        createdAt DESC
    `
	return db.execute(query).then((result) => {
		const parsed = z.array(ImageResourceSchema).safeParse(result.rows)
		return parsed.success ? parsed.data : []
	})
}
