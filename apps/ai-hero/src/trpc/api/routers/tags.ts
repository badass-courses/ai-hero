import { addTagToPost, getPost, removeTagFromPost } from '@/lib/posts-query'
import { TagSchema, type Tag } from '@/lib/tags'
import { createTag, getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from '@/trpc/api/trpc'
import { subject } from '@casl/ability'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

/**
 * Tag creation mirrors post creation (`create` on `Content`). All mutations sit
 * behind `protectedProcedure` so an anonymous caller is rejected before the
 * ability check runs.
 */
async function assertCan(action: 'create' | 'update') {
	const { ability } = await getServerAuthSession()
	if (!ability.can(action, 'Content')) {
		throw new TRPCError({ code: 'UNAUTHORIZED' })
	}
}

/**
 * Attach/detach targets a POST, so it is authorized against that post — the
 * same `subject('Content', post)` test `updatePost` and `deletePost` apply
 * (posts-query.ts), not a blanket `update Content`.
 *
 * The blanket check was too coarse: `addTagToPost`/`removeTagFromPost` write
 * the join row and perform no authorization of their own, so anyone holding
 * `update` on Content in the abstract could retag ANY post, including one they
 * have no rights to edit. Contributor abilities in this app are scoped per
 * resource, and this was the one write path that ignored that.
 */
async function assertCanEditPost(postId: string) {
	const { ability } = await getServerAuthSession()
	const post = await getPost(postId)
	if (!post || !ability.can('update', subject('Content', post))) {
		throw new TRPCError({ code: 'UNAUTHORIZED' })
	}
}

const PostTagInputSchema = z.object({
	postId: z.string(),
	tagId: z.string(),
})

export const tagsRouter = createTRPCRouter({
	getTags: publicProcedure.query(async () => {
		return getTags()
	}),
	createTag: protectedProcedure
		.input(TagSchema)
		.mutation(async ({ input }: { input: Tag }) => {
			await assertCan('create')
			return createTag(input)
		}),
	attachTag: protectedProcedure
		.input(PostTagInputSchema)
		.mutation(async ({ input }) => {
			await assertCanEditPost(input.postId)
			await addTagToPost(input.postId, input.tagId)
			return { success: true }
		}),
	removeTag: protectedProcedure
		.input(PostTagInputSchema)
		.mutation(async ({ input }) => {
			await assertCanEditPost(input.postId)
			await removeTagFromPost(input.postId, input.tagId)
			return { success: true }
		}),
})
