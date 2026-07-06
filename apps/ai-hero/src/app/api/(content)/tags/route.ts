import { NextRequest, NextResponse } from 'next/server'
import { TagSchema } from '@/lib/tags'
import { createTag, getTags } from '@/lib/tags-query'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { revalidateTag } from 'next/cache'

import { guid } from '@coursebuilder/utils/guid'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

/**
 * GET /api/tags
 *
 * List all tags. Public — mirrors the public `tags.getTags` tRPC query.
 */
const getTagsHandler = async () => {
	try {
		const tags = await getTags()
		return NextResponse.json(tags, { headers: corsHeaders })
	} catch (error) {
		await log.error('api.tags.get.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const GET = withSkill(getTagsHandler)

/**
 * POST /api/tags
 *
 * Create a tag. Body: `{ type?: 'topic', fields: { name, label, slug, … } }`.
 * `id` (5-char guid) and `createdAt`/`updatedAt` are server-generated when
 * absent — `createTag` inserts its input verbatim, so this route fills the
 * envelope the same way the admin tag dialog does.
 *
 * Bearer-token aware via `getUserAbilityForRequest` (device tokens can't
 * authenticate tRPC's cookie-session context, which is why the protected
 * `tags.createTag` procedure is unreachable for the cb CLI). Requires the
 * same ability as the tRPC procedure: `create Content`.
 */
const createTagHandler = async (request: NextRequest) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn('api.tags.post.unauthorized')
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('create', 'Content')) {
			await log.warn('api.tags.post.forbidden', { userId: user.id })
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json()
		const now = new Date()
		const parsed = TagSchema.safeParse({
			id: body?.id ?? guid(),
			type: body?.type ?? 'topic',
			fields: body?.fields,
			createdAt: body?.createdAt ?? now,
			updatedAt: body?.updatedAt ?? now,
		})
		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid tag payload', issues: parsed.error.issues },
				{ status: 400, headers: corsHeaders },
			)
		}

		// Slugs and names are lookup keys — refuse duplicates instead of
		// silently inserting a second tag the UI can't distinguish.
		const existing = await getTags()
		const duplicate = existing.find(
			(tag) =>
				tag.fields.slug === parsed.data.fields.slug ||
				tag.fields.name === parsed.data.fields.name ||
				tag.id === parsed.data.id,
		)
		if (duplicate) {
			return NextResponse.json(
				{ error: 'Tag already exists', existing: duplicate },
				{ status: 409, headers: corsHeaders },
			)
		}

		const tag = await createTag(parsed.data)
		revalidateTag('tags', 'max')

		await log.info('api.tags.post.success', {
			userId: user.id,
			tagId: tag.id,
			slug: tag.fields.slug,
		})

		return NextResponse.json(tag, { status: 201, headers: corsHeaders })
	} catch (error) {
		await log.error('api.tags.post.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const POST = withSkill(createTagHandler)
