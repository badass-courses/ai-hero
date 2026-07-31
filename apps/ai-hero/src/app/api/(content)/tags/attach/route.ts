import { NextRequest, NextResponse } from 'next/server'
import { addTagToPost, removeTagFromPost } from '@/lib/posts-query'
import { getTags } from '@/lib/tags-query'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { courseBuilderAdapter } from '@/db'
import { z } from 'zod'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const PostTagInputSchema = z.object({
	postId: z.string(),
	tagId: z.string(),
})

/**
 * Shared plumbing for attach (POST) and detach (DELETE): Bearer-aware auth via
 * `getUserAbilityForRequest` (the protected `tags.attachTag/removeTag` tRPC
 * procedures only accept cookie sessions, so the cb CLI can't reach them),
 * the same `update Content` ability the tRPC router demands, input validation,
 * and existence checks — `addTagToPost` inserts blindly, so a typo'd id would
 * otherwise create a dangling join row.
 */
const handleTagAttachment = async (
	request: NextRequest,
	action: 'attach' | 'remove',
) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn(`api.tags.${action}.unauthorized`)
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('update', 'Content')) {
			await log.warn(`api.tags.${action}.forbidden`, { userId: user.id })
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json()
		const parsed = PostTagInputSchema.safeParse(body)
		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid payload', issues: parsed.error.issues },
				{ status: 400, headers: corsHeaders },
			)
		}
		const { postId, tagId } = parsed.data

		const post = await courseBuilderAdapter.getContentResource(postId)
		if (!post) {
			return NextResponse.json(
				{ error: `Post not found: ${postId}` },
				{ status: 404, headers: corsHeaders },
			)
		}

		const tags = await getTags()
		const tag = tags.find((t) => t.id === tagId)
		if (!tag) {
			return NextResponse.json(
				{ error: `Tag not found: ${tagId}` },
				{ status: 404, headers: corsHeaders },
			)
		}

		if (action === 'attach') {
			await addTagToPost(postId, tagId)
		} else {
			await removeTagFromPost(postId, tagId)
		}

		await log.info(`api.tags.${action}.success`, {
			userId: user.id,
			postId,
			tagId,
		})

		return NextResponse.json(
			{ success: true, action, postId, tagId },
			{ headers: corsHeaders },
		)
	} catch (error) {
		await log.error(`api.tags.${action}.failed`, {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

/** POST /api/tags/attach — attach a tag to a post: `{ postId, tagId }`. */
const attachHandler = (request: NextRequest) =>
	handleTagAttachment(request, 'attach')
export const POST = withSkill(attachHandler)

/** DELETE /api/tags/attach — detach a tag from a post: `{ postId, tagId }`. */
const removeHandler = (request: NextRequest) =>
	handleTagAttachment(request, 'remove')
export const DELETE = withSkill(removeHandler)
