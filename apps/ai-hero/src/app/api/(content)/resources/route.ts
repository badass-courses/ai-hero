import { revalidateTag } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'
import { courseBuilderAdapter, db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { getAllLists } from '@/lib/lists-query'
import { sanitizeResourcePayload } from '@/lib/resource-api-sanitizer'
import {
	sortByStartTime,
	validateChapters,
} from '@/components/video-chapters/chapter-utils'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { guid } from '@coursebuilder/utils/guid'
import { VideoChapterSchema } from '@coursebuilder/core/schemas'
import slugify from '@sindresorhus/slugify'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

/**
 * GET /api/resources?slugOrId=<slug-or-id>&type=<type>
 *
 * Fetch any content resource by slug or ID, optionally filtered by type.
 * Returns the full resource with nested resources.
 */
const getResourceHandler = async (request: NextRequest) => {
	const { searchParams } = new URL(request.url)
	const slugOrId = searchParams.get('slugOrId')
	const type = searchParams.get('type')

	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		await log.info('api.resources.get.started', {
			userId: user?.id,
			slugOrId,
			type,
		})

		if (ability.cannot('read', 'Content')) {
			return NextResponse.json(
				{ error: user ? 'Forbidden' : 'Unauthorized', docs: '/api' },
				{ status: user ? 403 : 401, headers: corsHeaders },
			)
		}

		// List-all: GET /api/resources?type=list returns every list (no slugOrId).
		// Gated like the single-lesson reader — a valid token with read access is
		// required, which an admin token satisfies; guests get 401. Only `list` is
		// supported here to avoid exposing ungated enumeration of other types.
		if (!slugOrId) {
			if (type !== 'list') {
				return NextResponse.json(
					{
						error:
							'Missing slugOrId parameter. List-all is only supported for ?type=list.',
					},
					{ status: 400, headers: corsHeaders },
				)
			}

			const lists = await getAllLists()

			await log.info('api.resources.get.list-all.success', {
				userId: user?.id,
				type,
				resultCount: lists.length,
			})

			return NextResponse.json(sanitizeResourcePayload(lists), {
				headers: corsHeaders,
			})
		}

		const conditions = [
			or(
				eq(contentResource.id, slugOrId),
				eq(sql`JSON_EXTRACT(${contentResource.fields}, "$.slug")`, slugOrId),
			),
		]

		if (type) {
			conditions.push(eq(contentResource.type, type))
		}

		const resource = await db.query.contentResource.findFirst({
			where: and(...conditions),
			with: {
				resources: {
					with: {
						resource: true,
					},
				},
				resourceProducts: {
					with: {
						product: {
							with: {
								price: true,
							},
						},
					},
				},
			},
		})

		if (!resource) {
			return NextResponse.json(
				{ error: 'Resource not found' },
				{ status: 404, headers: corsHeaders },
			)
		}

		await log.info('api.resources.get.success', {
			userId: user?.id,
			resourceId: resource.id,
			type: resource.type,
		})

		return NextResponse.json(sanitizeResourcePayload(resource), {
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.resources.get.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			slugOrId,
			type,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const GET = withSkill(getResourceHandler)

/**
 * PUT /api/resources?id=<id>
 *
 * Update any content resource fields by ID.
 * Body: { fields: { ...partial fields to merge } }
 *
 * The fields are merged with existing fields (not replaced).
 * Requires 'update Content' ability.
 */
const updateResourceHandler = async (request: NextRequest) => {
	const { searchParams } = new URL(request.url)
	const id = searchParams.get('id')

	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn('api.resources.put.unauthorized', {
				resourceId: id,
			})
			return NextResponse.json(
				{ error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('update', 'Content')) {
			await log.warn('api.resources.put.forbidden', {
				userId: user.id,
				resourceId: id,
			})
			return NextResponse.json(
				{ error: 'Forbidden', docs: '/api' },
				{ status: 403, headers: corsHeaders },
			)
		}

		if (!id) {
			return NextResponse.json(
				{ error: 'Missing id parameter' },
				{ status: 400, headers: corsHeaders },
			)
		}

		const currentResource = await courseBuilderAdapter.getContentResource(id)

		if (!currentResource) {
			return NextResponse.json(
				{ error: 'Resource not found' },
				{ status: 404, headers: corsHeaders },
			)
		}

		const body = await request.json()

		await log.info('api.resources.put.started', {
			userId: user.id,
			resourceId: id,
			type: currentResource.type,
			changes: body.fields ? Object.keys(body.fields) : [],
		})

		const incomingFields = { ...(body?.fields ?? {}) }

		if (
			incomingFields.chapters !== undefined &&
			incomingFields.chapters !== null
		) {
			const parsed = z
				.array(VideoChapterSchema)
				.safeParse(incomingFields.chapters)
			if (!parsed.success) {
				await log.warn('api.resources.put.invalid-chapters', {
					userId: user.id,
					resourceId: id,
					issues: parsed.error.issues,
				})
				return NextResponse.json(
					{ error: 'Invalid chapters payload', issues: parsed.error.issues },
					{ status: 400, headers: corsHeaders },
				)
			}

			const duration =
				currentResource.type === 'videoResource'
					? ((currentResource.fields as { duration?: number | null })
							?.duration ?? null)
					: null
			const validationError = validateChapters(parsed.data, duration)
			if (validationError) {
				await log.warn('api.resources.put.invalid-chapters', {
					userId: user.id,
					resourceId: id,
					reason: validationError.kind,
					detail: validationError,
				})
				const message =
					validationError.kind === 'duplicate-startTime'
						? 'Duplicate startTime values are not allowed'
						: validationError.kind === 'startTime-exceeds-duration'
							? `Chapter startTime ${validationError.startTime} exceeds video duration ${validationError.duration}`
							: 'Chapter title cannot be empty'
				return NextResponse.json(
					{ error: message },
					{ status: 400, headers: corsHeaders },
				)
			}

			incomingFields.chapters = sortByStartTime(parsed.data)
		}

		const mergedFields = { ...currentResource.fields, ...incomingFields }

		const result = await courseBuilderAdapter.updateContentResourceFields({
			id,
			fields: mergedFields,
		})

		if (
			currentResource.type === 'videoResource' &&
			incomingFields.chapters !== undefined
		) {
			revalidateTag(`video-resource:${id}`, 'max')
		}

		await log.info('api.resources.put.success', {
			userId: user.id,
			resourceId: id,
			type: currentResource.type,
		})

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		await log.error('api.resources.put.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			resourceId: id,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const PUT = withSkill(updateResourceHandler)

/**
 * POST /api/resources
 *
 * Create any content resource.
 * Body: { type: string, title: string, fields?: { slug?, body?, state?, visibility?, ...} }
 *
 * If fields.slug is not provided, one is generated from the title.
 * Requires 'create Content' ability.
 */
const createResourceHandler = async (request: NextRequest) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn('api.resources.post.unauthorized')
			return NextResponse.json(
				{ error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('create', 'Content')) {
			await log.warn('api.resources.post.forbidden', {
				userId: user.id,
			})
			return NextResponse.json(
				{ error: 'Forbidden', docs: '/api' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json()
		const { type, title, fields: inputFields } = body

		if (!type || typeof type !== 'string') {
			return NextResponse.json(
				{ error: 'Missing or invalid "type" field' },
				{ status: 400, headers: corsHeaders },
			)
		}

		if (!title || typeof title !== 'string' || title.trim().length < 2) {
			return NextResponse.json(
				{ error: 'Missing or invalid "title" field (min 2 characters)' },
				{ status: 400, headers: corsHeaders },
			)
		}

		const hash = guid()
		const newResourceId = slugify(`${type}~${hash}`)
		const resolvedSlug = inputFields?.slug || slugify(`${title}~${hash}`)

		const fields = {
			title: title.trim(),
			state: 'draft',
			visibility: 'unlisted',
			...inputFields,
			slug: resolvedSlug,
		}

		await log.info('api.resources.post.started', {
			userId: user.id,
			type,
			title,
			slug: fields.slug,
		})

		await db.insert(contentResource).values({
			id: newResourceId,
			type,
			fields,
			createdById: user.id,
		})

		const resource = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, newResourceId),
			with: {
				resources: {
					with: {
						resource: true,
					},
					orderBy: asc(contentResourceResource.position),
				},
			},
		})

		const parsed = ContentResourceSchema.safeParse(resource)
		if (!parsed.success) {
			await log.error('api.resources.post.parse_error', {
				error: parsed.error.message,
				resourceId: newResourceId,
			})
			return NextResponse.json(
				{ error: 'Resource created but failed to parse', id: newResourceId },
				{ status: 201, headers: corsHeaders },
			)
		}

		await log.info('api.resources.post.success', {
			userId: user.id,
			resourceId: newResourceId,
			type,
			slug: fields.slug,
		})

		return NextResponse.json(parsed.data, {
			status: 201,
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.resources.post.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const POST = withSkill(createResourceHandler)
