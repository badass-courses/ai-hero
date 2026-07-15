import { addTagToPost, removeTagFromPost } from '@/lib/posts-query'
import { TagSchema, type Tag } from '@/lib/tags'
import { createTag, getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

/**
 * Tag attach/detach targets a post, so it requires the same ability post
 * mutations demand (`update` on `Content`); tag creation mirrors post
 * creation (`create` on `Content`). All mutations sit behind
 * `protectedProcedure` so an anonymous caller is rejected before the ability
 * check runs.
 */
async function assertCan(action: 'create' | 'update') {
	const { ability } = await getServerAuthSession()
	if (!ability.can(action, 'Content')) {
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
			await assertCan('update')
			await addTagToPost(input.postId, input.tagId)
			return { success: true }
		}),
	removeTag: protectedProcedure
		.input(PostTagInputSchema)
		.mutation(async ({ input }) => {
			await assertCan('update')
			await removeTagFromPost(input.postId, input.tagId)
			return { success: true }
		}),
})
